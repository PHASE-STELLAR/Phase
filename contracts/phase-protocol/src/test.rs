use super::*;
use crate::economy::{
    BOND_ACTIVE, BOND_CHALLENGE_WINDOW_SECS, BOND_COMPENSATED, BOND_RELEASED, TIP_FEE_BP,
};
use soroban_sdk::testutils::{Address as _, Ledger};
use soroban_sdk::{token, vec, Address, BytesN, Env, String};

struct Fixture {
    env: Env,
    client: PhaseProtocolClient<'static>,
    liq: Address,
    treasury: Address,
    admin: Address,
}

fn setup() -> Fixture {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let liq = env.register_stellar_asset_contract_v2(admin.clone()).address();
    let id = env.register(PhaseProtocol, ());
    let client = PhaseProtocolClient::new(&env, &id);
    client.initialize(&admin, &liq, &10_000_000i128, &treasury);
    Fixture { env, client, liq, treasury, admin }
}

fn fund(f: &Fixture, who: &Address, amount: i128) {
    token::StellarAssetClient::new(&f.env, &f.liq).mint(who, &amount);
}

fn bal(f: &Fixture, tok: &Address, who: &Address) -> i128 {
    token::Client::new(&f.env, tok).balance(who)
}

fn ref32(env: &Env, b: u8) -> BytesN<32> {
    BytesN::from_array(env, &[b; 32])
}

// ── 694 collection coins ────────────────────────────────────────────────────

fn mint_nft(f: &Fixture, creator: &Address, fan: &Address) -> (u64, u64) {
    let cid = f.client.create_collection(
        creator,
        &String::from_str(&f.env, "Coins"),
        &10_000_000i128,
        &String::from_str(&f.env, "ipfs://x"),
    );
    fund(f, fan, 50_000_000);
    let token_id = f.client.initiate_phase(fan, &f.liq, &cid);
    (cid, token_id)
}

#[test]
fn coin_reward_requires_verification_and_is_once_per_nft() {
    let f = setup();
    let creator = Address::generate(&f.env);
    let fan = Address::generate(&f.env);
    let (cid, token_id) = mint_nft(&f, &creator, &fan);

    let coin_sac = f.env.register_stellar_asset_contract_v2(creator.clone());
    // Issuer hands SAC admin to the protocol so it can mint fan rewards.
    token::StellarAssetClient::new(&f.env, &coin_sac.address()).set_admin(&f.client.address);
    let coin = coin_sac.address();

    f.client.register_collection_coin(&creator, &cid, &coin, &5_000_000i128);
    assert_eq!(
        f.client.try_claim_fan_reward(&fan, &token_id),
        Err(Ok(PhaseError::CoinNotVerified))
    );

    f.client.verify_collection_coin(&cid, &true);
    assert_eq!(f.client.claim_fan_reward(&fan, &token_id), 5_000_000);
    assert_eq!(bal(&f, &coin, &fan), 5_000_000);
    assert_eq!(
        f.client.try_claim_fan_reward(&fan, &token_id),
        Err(Ok(PhaseError::RewardAlreadyClaimed))
    );

    // Moving the NFT does not reset the claim.
    let other = Address::generate(&f.env);
    f.client.transfer(&fan, &other, &token_id);
    assert_eq!(
        f.client.try_claim_fan_reward(&other, &token_id),
        Err(Ok(PhaseError::RewardAlreadyClaimed))
    );

    f.client.redeem_collection_coin(&fan, &cid, &2_000_000i128);
    assert_eq!(bal(&f, &coin, &fan), 3_000_000);
    let rec = f.client.get_collection_coin(&cid).unwrap();
    assert_eq!((rec.minted, rec.redeemed), (5_000_000, 2_000_000));
}

#[test]
fn coin_registry_blocks_spoofing() {
    let f = setup();
    let creator = Address::generate(&f.env);
    let fan = Address::generate(&f.env);
    let (cid, _) = mint_nft(&f, &creator, &fan);
    let coin = f.env.register_stellar_asset_contract_v2(creator.clone()).address();

    let impostor = Address::generate(&f.env);
    assert_eq!(
        f.client.try_register_collection_coin(&impostor, &cid, &coin, &1i128),
        Err(Ok(PhaseError::NotAuthorized))
    );
    assert_eq!(
        f.client.try_register_collection_coin(&creator, &cid, &f.liq, &1i128),
        Err(Ok(PhaseError::UnauthorizedToken))
    );
    f.client.register_collection_coin(&creator, &cid, &coin, &1i128);
    let cid2 = f.client.create_collection(
        &creator,
        &String::from_str(&f.env, "Second"),
        &10_000_000i128,
        &String::from_str(&f.env, "ipfs://y"),
    );
    assert_eq!(
        f.client.try_register_collection_coin(&creator, &cid2, &coin, &1i128),
        Err(Ok(PhaseError::CoinAlreadyRegistered))
    );
    assert_eq!(f.client.get_coin_collection_id(&coin), Some(cid));
}

// ── 697 tips ────────────────────────────────────────────────────────────────

#[test]
fn tip_splits_after_fee_and_rejects_replay_and_self_tip() {
    let f = setup();
    let tipper = Address::generate(&f.env);
    let author = Address::generate(&f.env);
    let replier = Address::generate(&f.env);
    fund(&f, &tipper, 100_000_000);

    let amount: i128 = 10_000_001; // odd amount exercises the dust path
    let tip = ref32(&f.env, 1);
    let net = f.client.tip_signal(
        &tipper,
        &tip,
        &vec![&f.env, author.clone(), replier.clone()],
        &vec![&f.env, 7_000u32, 3_000u32],
        &amount,
    );
    let fee = amount * TIP_FEE_BP / 10_000;
    assert_eq!(net, amount - fee);
    assert_eq!(bal(&f, &f.liq, &f.treasury), fee);
    assert_eq!(bal(&f, &f.liq, &author) + bal(&f, &f.liq, &replier), net);
    assert_eq!(bal(&f, &f.liq, &replier), net * 3_000 / 10_000);

    assert_eq!(
        f.client.try_tip_signal(&tipper, &tip, &vec![&f.env, author.clone()], &vec![&f.env, 10_000u32], &amount),
        Err(Ok(PhaseError::TipReplay))
    );
    assert_eq!(
        f.client.try_tip_signal(&tipper, &ref32(&f.env, 2), &vec![&f.env, tipper.clone()], &vec![&f.env, 10_000u32], &amount),
        Err(Ok(PhaseError::SelfDeal))
    );
    assert_eq!(
        f.client.try_tip_signal(&tipper, &ref32(&f.env, 3), &vec![&f.env, author.clone()], &vec![&f.env, 9_999u32], &amount),
        Err(Ok(PhaseError::InvalidSplit))
    );
    assert_eq!(
        f.client.try_tip_signal(&tipper, &ref32(&f.env, 4), &vec![&f.env, author.clone()], &vec![&f.env, 10_000u32], &999i128),
        Err(Ok(PhaseError::TipBelowMinimum))
    );
}

// ── 698 endowments ──────────────────────────────────────────────────────────

#[test]
fn endowment_vests_yield_only_and_locks_principal() {
    let f = setup();
    let donor = Address::generate(&f.env);
    let creator = Address::generate(&f.env);
    let funder = Address::generate(&f.env);
    fund(&f, &donor, 1_000_000_000);
    fund(&f, &funder, 1_000_000_000);
    f.env.ledger().with_mut(|l| l.timestamp = 1_000);

    let id = f.client.create_endowment(&donor, &creator, &500_000_000i128, &10_000u64, &100u64, &1_000u64);
    f.client.fund_endowment_yield(&funder, &id, &1_000_000i128);

    f.env.ledger().with_mut(|l| l.timestamp = 1_050);
    assert_eq!(f.client.try_claim_endowment_yield(&id), Err(Ok(PhaseError::NothingToClaim)));

    f.env.ledger().with_mut(|l| l.timestamp = 1_500);
    assert_eq!(f.client.claim_endowment_yield(&id), 500_000);
    assert_eq!(bal(&f, &f.liq, &creator), 500_000);
    let (vested, claimed, locked) = f.client.get_endowment_vesting(&id);
    assert_eq!((vested, claimed, locked), (500_000, 500_000, 500_000_000));

    assert_eq!(f.client.try_withdraw_endowment_principal(&id), Err(Ok(PhaseError::EndowmentLocked)));

    // Revoke at 60%: 100k more vested for creator, 400k unvested back to donor.
    f.env.ledger().with_mut(|l| l.timestamp = 1_600);
    let donor_before = bal(&f, &f.liq, &donor);
    f.client.revoke_endowment(&id);
    assert_eq!(bal(&f, &f.liq, &donor) - donor_before, 400_000);
    f.env.ledger().with_mut(|l| l.timestamp = 5_000);
    assert_eq!(f.client.claim_endowment_yield(&id), 100_000);
    assert_eq!(f.client.try_fund_endowment_yield(&funder, &id, &1i128), Err(Ok(PhaseError::EndowmentClosed)));

    f.env.ledger().with_mut(|l| l.timestamp = 11_000);
    assert_eq!(f.client.withdraw_endowment_principal(&id), 500_000_000);
    assert_eq!(f.client.try_withdraw_endowment_principal(&id), Err(Ok(PhaseError::EndowmentClosed)));
}

#[test]
fn endowment_dispute_freezes_claims_and_upheld_unlocks_principal() {
    let f = setup();
    let donor = Address::generate(&f.env);
    let creator = Address::generate(&f.env);
    fund(&f, &donor, 1_000_000_000);
    let id = f.client.create_endowment(&donor, &creator, &100_000_000i128, &1_000_000u64, &0u64, &100u64);
    f.client.fund_endowment_yield(&donor, &id, &1_000i128);
    f.env.ledger().with_mut(|l| l.timestamp += 50);

    f.client.open_endowment_dispute(&id);
    assert_eq!(f.client.try_claim_endowment_yield(&id), Err(Ok(PhaseError::DisputeOpen)));
    f.client.resolve_endowment_dispute(&id, &true);
    assert_eq!(f.client.claim_endowment_yield(&id), 500);
    assert_eq!(f.client.withdraw_endowment_principal(&id), 100_000_000);
    assert_eq!(
        f.client.try_create_endowment(&donor, &donor, &1i128, &0u64, &0u64, &1u64),
        Err(Ok(PhaseError::SelfDeal))
    );
}

// ── 699 listing bonds ───────────────────────────────────────────────────────

#[test]
fn bond_release_requires_window_and_no_challenge() {
    let f = setup();
    let seller = Address::generate(&f.env);
    fund(&f, &seller, 100_000_000);
    let r = ref32(&f.env, 9);
    f.client.post_listing_bond(&seller, &r, &50_000_000i128);
    assert_eq!(
        f.client.try_post_listing_bond(&seller, &r, &50_000_000i128),
        Err(Ok(PhaseError::BondAlreadyPosted))
    );
    assert_eq!(f.client.try_release_listing_bond(&r), Err(Ok(PhaseError::BondLocked)));
    f.env.ledger().with_mut(|l| l.timestamp += BOND_CHALLENGE_WINDOW_SECS);
    assert_eq!(f.client.release_listing_bond(&r), 50_000_000);
    assert_eq!(f.client.get_listing_bond(&r).unwrap().status, BOND_RELEASED);
    assert_eq!(bal(&f, &f.liq, &seller), 100_000_000);
}

#[test]
fn bond_challenge_slash_compensates_and_rejection_forfeits_stake() {
    let f = setup();
    let seller = Address::generate(&f.env);
    let challenger = Address::generate(&f.env);
    fund(&f, &seller, 100_000_000);
    fund(&f, &challenger, 100_000_000);

    // Rejected challenge: stake goes to the seller, bond stays active.
    let r1 = ref32(&f.env, 1);
    f.client.post_listing_bond(&seller, &r1, &10_000_000i128);
    assert_eq!(
        f.client.try_challenge_listing_bond(&seller, &r1, &ref32(&f.env, 7)),
        Err(Ok(PhaseError::SelfDeal))
    );
    let stake = f.client.challenge_listing_bond(&challenger, &r1, &ref32(&f.env, 7));
    assert_eq!(stake, 1_000_000);
    assert_eq!(
        f.client.try_challenge_listing_bond(&challenger, &r1, &ref32(&f.env, 7)),
        Err(Ok(PhaseError::BondChallengeOpen))
    );
    assert_eq!(f.client.adjudicate_listing_bond(&r1, &false, &0u32, &0u32), BOND_ACTIVE);
    assert_eq!(bal(&f, &f.liq, &seller), 100_000_000 - 10_000_000 + 1_000_000);

    // Upheld: slash 50% of 20M = 10M, 40% of that (4M) to challenger + stake back.
    let r2 = ref32(&f.env, 2);
    f.client.post_listing_bond(&seller, &r2, &20_000_000i128);
    f.client.challenge_listing_bond(&challenger, &r2, &ref32(&f.env, 8));
    let ch_before = bal(&f, &f.liq, &challenger);
    let seller_before = bal(&f, &f.liq, &seller);
    assert_eq!(f.client.adjudicate_listing_bond(&r2, &true, &5_000u32, &4_000u32), BOND_COMPENSATED);
    assert_eq!(bal(&f, &f.liq, &challenger) - ch_before, 4_000_000 + 2_000_000);
    assert_eq!(bal(&f, &f.liq, &f.treasury), 6_000_000);
    assert_eq!(bal(&f, &f.liq, &seller) - seller_before, 10_000_000);
    assert_eq!(f.client.try_release_listing_bond(&r2), Err(Ok(PhaseError::BondNotActive)));
    let _ = &f.admin;
}
