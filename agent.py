#!/usr/bin/env python3
"""Domácí agent: běží na PC v LAN se žárovkou, tahá příkazy ze serveru a posílá je žárovce WiZ.
Spuštění:  python3 agent.py   (Windows: py agent.py)  — jen standardní knihovna."""
import http.client, json, os, math, socket, ssl, threading, time

HOST = "zarovka.thugsclub.eu"   # certifikát se ověřuje na toto jméno
ORIGIN_IP = "62.238.53.187"     # připojujeme se napřímo na server, mimo Cloudflare
# Klíč agenta: proměnná prostředí AGENT_KEY, nebo soubor agent.key vedle skriptu
AGENT_KEY = os.environ.get("AGENT_KEY") or open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "agent.key")).read().strip()
BULB = ("192.168.0.125", 38899)


def bulb(method, params=None):
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.settimeout(2)
    try:
        s.sendto(json.dumps({"method": method, "params": params or {}}).encode(), BULB)
        return json.loads(s.recvfrom(2048)[0])
    except Exception as e:
        print("Žárovka neodpovídá:", e)
        return None
    finally:
        s.close()


TLS = ssl.create_default_context()


class Conn(http.client.HTTPSConnection):
    """HTTPS na IP serveru, ale TLS (SNI + ověření certifikátu) pro HOST."""
    def connect(self):
        sock = socket.create_connection((ORIGIN_IP, 443), self.timeout)
        self.sock = TLS.wrap_socket(sock, server_hostname=HOST)


def req(path, data=None, timeout=35):
    c = Conn(HOST, timeout=timeout)
    try:
        body = json.dumps(data).encode() if data is not None else None
        c.request("POST" if body else "GET", path, body=body,
                  headers={"Host": HOST, "X-Agent-Key": AGENT_KEY, "Content-Type": "application/json"})
        r = c.getresponse()
        if r.status != 200:
            raise RuntimeError(f"server vrátil {r.status}")
        return json.loads(r.read())
    finally:
        c.close()


def report():
    p = bulb("getPilot")
    if p and "result" in p:
        req("/agent/state", {"state": p["result"]}, timeout=10)


EFFECT_SECONDS = 20
stop = threading.Event()


def fire(params):  # rychlé odeslání bez čekání na odpověď
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.sendto(json.dumps({"method": "setPilot", "params": params}).encode(), BULB)
    s.close()


def hue(h):
    f = lambda n: round(255 * (1 - max(0, min((n + h / 60) % 6, 4 - (n + h / 60) % 6, 1))))
    return {"r": f(5), "g": f(3), "b": f(1)}


def effect(name, ev):
    end = time.time() + EFFECT_SECONDS
    i = 0
    while time.time() < end and not ev.is_set():
        if name == "rainbow":
            fire({"state": True, "dimming": 100, **hue(i * 12 % 360)}); dt = 0.15
        elif name == "strobe":   # 3 záblesky/s – pod hranicí, kde hrozí fotosenzitivní záchvaty
            fire({"state": True, "dimming": 100, "temp": 6500} if i % 2 == 0 else {"state": False}); dt = 0.17
        elif name == "police":
            fire({"state": True, "dimming": 100, "r": 255, "g": 0, "b": 0} if (i // 3) % 2 == 0 else {"state": True, "dimming": 100, "r": 0, "g": 0, "b": 255}); dt = 0.12
        elif name == "breathe":
            fire({"state": True, "r": 255, "g": 120, "b": 40, "dimming": int(10 + 90 * (0.5 - 0.5 * math.cos(i / 8)))}); dt = 0.12
        else:
            return
        i += 1
        ev.wait(dt)
    if not ev.is_set():
        fire({"state": True, "temp": 2700, "dimming": 80})  # po efektu zpět na teplou bílou


def run(c):
    global stop
    stop.set()                 # nový příkaz zastaví běžící efekt
    stop = threading.Event()
    if "effect" in c:
        threading.Thread(target=effect, args=(c["effect"], stop), daemon=True).start()
    else:
        print("Odpověď žárovky:", bulb("setPilot", c))


print("Agent běží, žárovka", BULB[0])
while True:
    try:
        report()
        for c in req("/agent/poll")["cmds"]:
            print("Příkaz:", c)
            run(c)
    except Exception as e:
        print("Chyba spojení:", e)
        time.sleep(5)
