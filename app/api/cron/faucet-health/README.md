# Faucet Health Monitor - Automated Balance Management

This cron endpoint provides automated monitoring and refill capabilities for the distributor wallet used in faucet transfer mode.

## Overview

When the faucet operates in **transfer mode** (using `FAUCET_DISTRIBUTOR_SECRET_KEY`), tokens are transferred from a pre-funded distributor wallet rather than minted directly. This endpoint monitors the distributor's balance and automatically refills it from the issuer when necessary.

## Features

1. **Automated Balance Monitoring**
   - Checks PHASELQ and XLM balances hourly
   - Monitors both distributor and issuer accounts
   - Records health history for trending

2. **Auto-Refill Engine**
   - Automatically mints PHASELQ from issuer to distributor
   - Triggers when distributor drops below 100 PHASELQ
   - Refills with 500 PHASELQ per trigger
   - Configurable thresholds

3. **Webhook Alerts**
   - Discord, Telegram, Slack, or generic webhook support
   - 24-hour advance warnings for low issuer funds
   - Critical alerts for XLM depletion (requires manual funding)
   - Success notifications for auto-refills

4. **Health Status API**
   - Real-time status via `/api/faucet/health`
   - Historical tracking of balance levels
   - UI-ready status messages

## Configuration

### Required Environment Variables

```bash
# Faucet Configuration
FAUCET_DISTRIBUTOR_SECRET_KEY=S...   # Distributor secret key
ADMIN_SECRET_KEY=S...                # Issuer secret key (must match NEXT_PUBLIC_CLASSIC_LIQ_ISSUER)
NEXT_PUBLIC_PHASER_LIQ_TOKEN_CONTRACT=C...  # Token contract ID

# Cron Authentication (for manual triggers)
CRON_SECRET=your-secret-here         # Bearer token for cron endpoint
```

### Optional Webhook Configuration

```bash
# Discord
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...

# Telegram
TELEGRAM_BOT_TOKEN=123456:ABC-DEF...
TELEGRAM_CHAT_ID=-1001234567890

# Slack
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...

# Generic webhook
GENERIC_WEBHOOK_URL=https://your-webhook-endpoint.com/alerts
```

### Vercel Cron Setup

Add to `vercel.json`:

```json
{
  "crons": [
    {
      "path": "/api/cron/faucet-health",
      "schedule": "0 * * * *"
    }
  ]
}
```

This runs the health check **every hour**.

### Mercury API (Optional Performance Enhancement)

For faster balance lookups, configure Mercury:

```bash
MERCURY_API_KEY=your-mercury-api-key
```

Falls back to Horizon if not configured.

## Thresholds

Default thresholds (configurable in code):

| Metric | Threshold | Action |
|--------|-----------|--------|
| Distributor PHASELQ | < 100 PHASELQ | Auto-refill 500 PHASELQ |
| Distributor XLM | < 50 XLM | Alert only (manual fund required) |
| Issuer PHASELQ | < 1000 PHASELQ | Warning alert (24h notice) |
| Issuer XLM | < 100 XLM | Warning alert |

## Endpoints

### Health Check Cron (Internal)

```
GET /api/cron/faucet-health
Authorization: Bearer <CRON_SECRET>
```

or triggered automatically by Vercel Cron.

**Response:**
```json
{
  "ok": true,
  "status": "healthy",
  "message": "All systems operational",
  "results": {
    "distributorCheck": {
      "address": "GABC...XYZ",
      "phaseLiq": "1500.00",
      "xlm": "75.50"
    },
    "issuerCheck": {
      "address": "GDEF...123",
      "phaseLiq": "50000.00",
      "xlm": "250.00"
    },
    "refillAttempt": {
      "success": true,
      "amountStroops": "5000000000",
      "hash": "abc123..."
    },
    "alerts": []
  }
}
```

### Public Health Status

```
GET /api/faucet/health
```

Returns current health status for UI display.

**Response:**
```json
{
  "ok": true,
  "status": "healthy",
  "message": "All systems operational",
  "current": {
    "distributorPhaseLiq": "1500.00",
    "distributorXlm": "75.50",
    "issuerPhaseLiq": "50000.00",
    "issuerXlm": "250.00",
    "checkedAt": "2024-08-31T12:00:00Z",
    "message": "All systems operational"
  },
  "recentHistory": [...],
  "lastRefillAt": "2024-08-31T11:30:00Z",
  "nextCheckIn": {
    "ms": 3600000,
    "minutes": 60,
    "humanReadable": "1h"
  }
}
```

## Alert Types

### Info Alerts (Green ✅)
- Auto-refill successful
- System operational

### Warning Alerts (Orange 🟠)
- Issuer PHASELQ low (24h warning)
- Issuer XLM low
- Distributor approaching threshold

### Critical Alerts (Red 🔴)
- Distributor XLM critical (< 50 XLM)
- Auto-refill failed
- System errors

## Webhook Payload Example

```json
{
  "type": "warning",
  "timestamp": "2024-08-31T12:00:00Z",
  "title": "🟠 Issuer PHASELQ Low",
  "message": "Issuer balance: 800.00 PHASELQ. Consider minting more tokens.",
  "issuerAddress": "GDEF...123",
  "issuerPhaseLiq": "800.00",
  "threshold": 1000
}
```

## Manual Testing

Trigger health check manually:

```bash
curl -X GET https://your-app.vercel.app/api/cron/faucet-health \
  -H "Authorization: Bearer your-cron-secret"
```

Test webhook configuration:

```bash
curl -X POST https://your-app.vercel.app/api/admin/test-webhooks \
  -H "Authorization: Bearer your-admin-token"
```

## UI Integration

Display health status in your faucet UI:

```typescript
const response = await fetch('/api/faucet/health')
const health = await response.json()

if (health.status === 'critical') {
  // Show maintenance banner
  showBanner(`Faucet maintenance: ${health.message}`)
} else if (health.status === 'warning') {
  // Show warning
  showWarning('Faucet may experience delays')
}
```

## Troubleshooting

### Auto-refill not working

1. Check `ADMIN_SECRET_KEY` matches the issuer public key
2. Verify issuer has sufficient PHASELQ to mint
3. Check issuer has at least 5 XLM for fees
4. Review logs in Vercel for errors

### Webhooks not sending

1. Verify webhook URLs are correct
2. Test webhook endpoints manually
3. Check webhook service status
4. Review Vercel function logs

### Health status not updating

1. Verify cron job is configured in `vercel.json`
2. Check cron execution in Vercel dashboard
3. Manually trigger endpoint to test
4. Review function timeout settings

## Monitoring Best Practices

1. **Set up alerts**: Configure at least one webhook type
2. **Monitor issuer balance**: Keep issuer funded with buffer
3. **Check logs regularly**: Review Vercel function logs weekly
4. **Test failover**: Manually trigger low-balance scenarios in staging
5. **XLM reserves**: Keep 100+ XLM in both issuer and distributor

## Security Considerations

1. **Rotate secrets**: Change `CRON_SECRET` monthly
2. **Webhook security**: Use authenticated webhook URLs when possible
3. **Rate limiting**: Monitor for abuse of manual trigger endpoint
4. **Access logs**: Review who accesses admin endpoints

## Migration from Mint Mode

If currently using mint mode (issuer directly mints):

1. Set up distributor account with trustline
2. Fund distributor with initial PHASELQ (1000+ recommended)
3. Configure `FAUCET_DISTRIBUTOR_SECRET_KEY`
4. Deploy with cron configuration
5. Monitor health endpoint for 24 hours
6. Gradually reduce manual funding as auto-refill proves stable

## Performance Impact

- Health check runtime: ~2-5 seconds
- Runs once per hour
- Minimal impact on main faucet operations
- Auto-refill adds ~5 seconds to affected faucet claims

## Cost Considerations

- Vercel Cron: Included in Pro plan (100 invocations/day)
- Network fees: ~0.01 XLM per auto-refill transaction
- Mercury API: Optional, improves speed
- Webhook delivery: Free (service-dependent)

## Roadmap

Future enhancements:
- [ ] Configurable thresholds via admin API
- [ ] Email alert support
- [ ] Historical balance graphs
- [ ] Predictive refill timing based on usage patterns
- [ ] Multi-distributor support
- [ ] Automatic XLM refill from issuer
