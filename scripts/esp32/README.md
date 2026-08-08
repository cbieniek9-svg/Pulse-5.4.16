# ESP32 BLE gateway (production)

Each corner USB ESP32 runs a passive BLE scanner and POSTs batches to Command Center:

- **Endpoint:** `POST /api/presence/ingest`
- **Auth:** header `X-Presence-Gateway-Key` (rotate in Manager → BLE Presence)
- **Body:** `{ "gateway_id": "GW-NW", "firmware": "esp32/1.0", "seen": [{ "beacon_id": "uuid", "rssi": -67 }] }`

## Gateway IDs (default map)

| ID | Zone |
|----|------|
| GW-RECV | Receiving (order headcount hint) |
| GW-NW | Zone 1 |
| GW-NE | Zone 2 |
| GW-S | Zone 3 |

## Wiring

1. Enable **Presence_Enabled** on the store PC after badges are mapped.
2. Copy gateway key to each ESP32 `config.h` (or NVS).
3. Power gateways from USB hubs; label physical corners to match `Presence_Gateway_Map`.
4. Map staff badge UUIDs in **Presence_Staff_Beacons** (manager config API or future UI).

## Dev without hardware

```bash
node scripts/presence-gateway-simulator.cjs --url http://127.0.0.1:3000 --key <key> --gateway GW-RECV --count 3
```

Zone assignment uses **strongest RSSI per corner**, not trilateration — reliable for warehouse aisles.
