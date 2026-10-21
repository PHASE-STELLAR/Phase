import { NextRequest, NextResponse } from 'next/server';

interface ProofVerifyRequest {
  msg_id: string;
  source_chain: string;
  signatures?: string[];
}

interface ProofVerifyResponse {
  msg_id: string;
  status: 'pending' | 'verified' | 'failed';
  source_chain: string;
  verified_at?: number;
  error?: string;
}

/**
 * GET /api/proof-verify?msg_id=...
 * Check the verification status of a cross-chain proof
 */
export async function GET(request: NextRequest) {
  try {
    const msg_id = request.nextUrl.searchParams.get('msg_id');
    if (!msg_id) {
      return NextResponse.json(
        { error: 'Missing msg_id parameter' },
        { status: 400 }
      );
    }

    // TODO: Call proof relay contract via Soroban RPC
    // const proofStatus = await env.call('get_proof', msg_id);

    const response: ProofVerifyResponse = {
      msg_id,
      status: 'pending',
      source_chain: 'unknown',
    };

    return NextResponse.json(response);
  } catch (error) {
    return NextResponse.json(
      { error: 'Proof verification failed', details: String(error) },
      { status: 500 }
    );
  }
}

/**
 * POST /api/proof-verify
 * Submit a proof with multi-signature attestations for verification
 */
export async function POST(request: NextRequest) {
  try {
    const body: ProofVerifyRequest = await request.json();

    if (!body.msg_id || !body.source_chain) {
      return NextResponse.json(
        { error: 'Missing required fields: msg_id, source_chain' },
        { status: 400 }
      );
    }

    // TODO: Call proof relay contract to submit proof
    // const result = await env.call('submit_proof', {
    //   msg_id: body.msg_id,
    //   source_chain: body.source_chain,
    //   signatures: body.signatures || [],
    // });

    const response: ProofVerifyResponse = {
      msg_id: body.msg_id,
      status: 'pending',
      source_chain: body.source_chain,
    };

    return NextResponse.json(response, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: 'Proof submission failed', details: String(error) },
      { status: 500 }
    );
  }
}
