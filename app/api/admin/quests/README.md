# Quest Registry Admin API

This API allows administrators to dynamically manage quest definitions without modifying code.

## Authentication

All endpoints require a Bearer token in the `Authorization` header:

```
Authorization: Bearer <ADMIN_API_TOKEN>
```

Set `ADMIN_API_TOKEN` in your environment variables.

## Endpoints

### GET /api/admin/quests

Get the complete quest registry.

**Response:**
```json
{
  "quests": [
    {
      "id": "quest_connect_wallet",
      "name": "Connect Wallet",
      "description": "Connect your Stellar wallet",
      "rewardStroops": "30000000",
      "enabled": true,
      "conditions": [{ "type": "wallet_connected" }],
      "requirementText": "Connect wallet is required.",
      "order": 1
    }
  ],
  "lastUpdated": 1234567890
}
```

### POST /api/admin/quests

Create a new quest.

**Request Body:**
```json
{
  "id": "quest_custom",
  "name": "Custom Quest",
  "description": "Complete a custom action",
  "rewardStroops": "40000000",
  "enabled": true,
  "conditions": [
    { "type": "collection_count", "params": { "minCount": 5 } }
  ],
  "requirementText": "Mint in 5 different collections.",
  "order": 6
}
```

**Response:**
```json
{
  "ok": true,
  "questId": "quest_custom"
}
```

### PATCH /api/admin/quests

Update quest configuration. Supports multiple actions:

#### Toggle Quest Enabled/Disabled

**Request Body:**
```json
{
  "action": "toggle",
  "questId": "quest_first_world",
  "enabled": false
}
```

#### Update Quest Reward Amount

**Request Body:**
```json
{
  "action": "updateReward",
  "questId": "quest_first_world",
  "rewardStroops": "60000000"
}
```

#### Update Quest Definition

**Request Body:**
```json
{
  "action": "update",
  "questId": "quest_first_world",
  "updates": {
    "name": "Updated Name",
    "description": "Updated description",
    "requirementText": "Updated requirement"
  }
}
```

#### Reorder Quests

**Request Body:**
```json
{
  "action": "reorder",
  "questIds": [
    "quest_connect_wallet",
    "quest_first_collection",
    "quest_first_settle",
    "quest_three_collections",
    "quest_first_world"
  ]
}
```

**Response:**
```json
{
  "ok": true,
  "questId": "quest_first_world"
}
```

### DELETE /api/admin/quests?questId=xxx

Remove a quest from the registry.

**Response:**
```json
{
  "ok": true,
  "questId": "quest_custom",
  "removed": true
}
```

## Quest Condition Types

Available condition types for quest definitions:

- `wallet_connected` - Wallet must be connected
- `nft_minted` - User has minted at least one NFT
- `collection_created` - User has created a collection
- `settlement_completed` - User has completed a settlement
- `world_created` - User has created a narrative world
- `collection_count` - User has minted in N collections
  - Params: `{ "minCount": 3 }`

## Examples

### Create a new "Power User" quest

```bash
curl -X POST http://localhost:3000/api/admin/quests \
  -H "Authorization: Bearer your-admin-token" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "quest_power_user",
    "name": "Power User",
    "description": "Mint in 10 different collections",
    "rewardStroops": "100000000",
    "enabled": true,
    "conditions": [
      { "type": "collection_count", "params": { "minCount": 10 } }
    ],
    "requirementText": "Mint in 10 different collections.",
    "order": 6
  }'
```

### Disable a quest temporarily

```bash
curl -X PATCH http://localhost:3000/api/admin/quests \
  -H "Authorization: Bearer your-admin-token" \
  -H "Content-Type: application/json" \
  -d '{
    "action": "toggle",
    "questId": "quest_first_world",
    "enabled": false
  }'
```

### Increase reward for a quest

```bash
curl -X PATCH http://localhost:3000/api/admin/quests \
  -H "Authorization: Bearer your-admin-token" \
  -H "Content-Type: application/json" \
  -d '{
    "action": "updateReward",
    "questId": "quest_three_collections",
    "rewardStroops": "75000000"
  }'
```

## Benefits

1. **Dynamic Campaign Creation**: Add new quests without code changes or deployments
2. **A/B Testing**: Toggle quests on/off to test engagement
3. **Reward Tuning**: Adjust reward amounts based on token economics
4. **Quest Ordering**: Control the quest progression flow
5. **No Downtime**: All changes take effect immediately

## Security Notes

- Always keep `ADMIN_API_TOKEN` secret and rotate it regularly
- Consider IP whitelisting for production environments
- Log all admin API calls for audit trails
- Use HTTPS in production to protect the admin token
