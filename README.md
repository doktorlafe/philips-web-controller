# 💡 Žárovka v pokojíčku

Veřejný web, přes který kdokoli z internetu ovládá skutečnou Philips WiZ žárovku u mě doma.
Kliknutí jde na server ve Finsku, odtud k domácímu agentovi a ten pošle příkaz žárovce po LAN (UDP 38899).

```
prohlížeč ──HTTPS──▶ Cloudflare ──▶ Caddy ──▶ server.js (Docker)
                                                 ▲  long-poll přes HTTPS
domácí PC: agent.py ─────────────────────────────┘
     └──UDP──▶ WiZ žárovka
```

## Funkce
- zapnutí/vypnutí, barva (duha, RGB), jas, teplota bílé, 22 scén WiZ
- efekty počítané agentem: duha, stroboskop (3 Hz), policie, dýchání
- limit jedné akce za N minut na IP (IPv6 po /64), výjimka pro admina
- veřejný log akcí s vlajkou země (z `CF-IPCountry`) a zkrácenou IP
- chat (1 zpráva / 10 s, mazání adminem)
- detekce offline agenta / žárovky
- napojení na n8n: webhook při každé akci, interní API `/internal/cmd`

## Spuštění serveru
```sh
cp .env.example .env   # doplň klíče
docker compose up -d --build
```
Caddy (musí propouštět web jen z IP Cloudflare, jinak lze podvrhnout `CF-Connecting-IP`):
```caddy
zarovka.example.com {
    handle /agent/* {
        reverse_proxy zarovka:9000
    }
    @notcf not remote_ip <rozsahy z https://www.cloudflare.com/ips/>
    abort @notcf
    respond /internal/* 404
    reverse_proxy zarovka:8080
    encode gzip
}
```

## Domácí agent
Python 3, jen standardní knihovna. Uprav `HOST`, `ORIGIN_IP` a `BULB` v `agent.py`, vedle něj ulož `agent.key` (hodnota `AGENT_KEY`) a spusť:
```sh
python agent.py
```
Ve WiZ aplikaci musí být povolená lokální komunikace a „Povolit všechny ovládací prvky“ (s rotací klíčů žárovka lokální příkazy odmítá).
