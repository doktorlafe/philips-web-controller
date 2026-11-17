# 💡 Philips Web Controller

<img width="1115" height="1156" alt="image" src="https://github.com/user-attachments/assets/6853b7c3-8a95-4f84-b6dc-d5a691dab0b6" />


A public website that lets anyone on the internet control a real Philips WiZ bulb in my room.
A click goes to a server in Finland, then to a small agent on my home PC, which sends the command to the bulb over the LAN (UDP 38899).

```
browser ──HTTPS──▶ Cloudflare ──▶ Caddy ──▶ server.js (Docker)
                                                ▲  long-poll over HTTPS
home PC: agent.py ──────────────────────────────┘
     └──UDP──▶ WiZ bulb
```

No port forwarding or VPN is needed at home: the agent connects out to the server and picks up commands.

## Features
- On/off, color (hue slider, exact RGB, presets), brightness, white temperature, 22 built-in WiZ scenes
- Agent-driven effects: rainbow, strobe (3 Hz, kept below photosensitivity risk), police, breathing
- Rate limit of one action per N minutes per IP (IPv6 per /64), with an admin exemption
- Public action log with country flag (from `CF-IPCountry`) and masked IP
- Chat (1 message per 10 s, admin can delete messages)
- Shows when the home agent or the bulb is offline
- n8n integration: webhook on every action/chat message, internal API `/internal/cmd` for automations
- Link preview banner (Open Graph)

## Running the server
```sh
cp .env.example .env   # fill in the keys
docker compose up -d --build
```

| Variable | Meaning |
|---|---|
| `AGENT_KEY` | Shared secret for the home agent (`openssl rand -hex 24`) |
| `INTERNAL_KEY` | Secret for the internal API used by n8n |
| `N8N_WEBHOOK` | Optional webhook URL that receives every action and chat message |
| `COOLDOWN_MIN` | Minutes between actions per visitor (default 2) |
| `EXEMPT_IPS` | Comma-separated admin IPs (no limit, shown as admin) |

Caddy config. The site **must only accept traffic from Cloudflare IPs**, otherwise anyone could forge the `CF-Connecting-IP` header and bypass the limit or impersonate the admin:
```caddy
zarovka.example.com {
    handle /agent/* {
        reverse_proxy zarovka:9000
    }
    @notcf not remote_ip <ranges from https://www.cloudflare.com/ips/>
    abort @notcf
    respond /internal/* 404
    reverse_proxy zarovka:8080
    encode gzip
}
```

## Home agent
Python 3, standard library only. Set `HOST`, `ORIGIN_IP` and `BULB` in `agent.py`, put the `AGENT_KEY` value into `agent.key` next to it (or set the `AGENT_KEY` environment variable) and run:
```sh
python agent.py
```
The agent connects directly to the origin server over HTTPS (bypassing Cloudflare's bot challenge) and verifies the certificate for `HOST`.

In the WiZ app, enable local communication and set it to **allow all controls**. With key rotation enabled, the bulb rejects local `setPilot` commands with `Invalid params`.

## n8n
Send commands from n8n with an HTTP Request node:
```
POST http://zarovka:8080/internal/cmd
X-Internal-Key: <INTERNAL_KEY>
{"on": true, "color": "#00ff00"}   or   {"scene": 9}   or   {"effect": "rainbow"}
```
