# Tapo NVR – înregistrare non-stop pentru Tapo C230

Aplicație locală care preia fluxul RTSP de la camera Tapo C230, îl salvează continuu pe disc
(segmente MP4 de 5 minute, fără re-encodare video) și oferă un client web cu:

- **Live** – flux HLS cu latență de ~4-6 s, sunet, captură foto, ecran complet
- **Arhivă** – alegere zi, linie de timp de 24 h cu zoom (rotița mouse-ului) și deplasare (tragere),
  click pentru redare din orice moment, trecere automată la segmentul următor, viteză 1×–16×,
  descărcare segmente, captură foto

## 1. Contul camerei (o singură dată)

Camera acceptă RTSP doar cu un *cont al camerei*, diferit de contul TP-Link:
aplicația Tapo → camera → ⚙ Setări → **Setări avansate → Contul camerei** → creează user + parolă.

## 2. Configurare – `config.json`

| Câmp | Semnificație |
|---|---|
| `camera.host` | IP-ul camerei (`192.168.100.213`, MAC `10:5A:95:5D:99:E6`) – rezervă IP-ul în DHCP-ul routerului |
| `camera.username/password` | contul camerei de la pasul 1 |
| `camera.recordStream` | `stream1` = 2K/1080p (calitate maximă), `stream2` = 360p |
| `camera.liveStream` | la fel ca recordStream = o singură conexiune la cameră |
| `dataDir` | unde se salvează (implicit `C:\TapoNVR`, **nu** în OneDrive) |
| `segmentSeconds` | lungimea unui fișier (300 s) |
| `retentionDays` | zilele păstrate; mai vechi se șterg automat |
| `maxArchiveGB` | dimensiunea maximă a arhivei (20 GB); la depășire se șterg cele mai vechi fișiere |
| `minFreeGB` | dacă spațiul liber scade sub prag se șterg cele mai vechi fișiere |
| `web.port` | portul clientului web (8080) |
| `web.username/password` | opțional: parolă pentru clientul web (recomandat dacă e accesibil din rețea) |

## 3. Pornire

- manual: `start.cmd` (sau `npm start`) → deschide http://localhost:8080
- **non-stop, la pornirea PC-ului** (fără logare, repornire automată):
  PowerShell ca Administrator →
  `powershell -ExecutionPolicy Bypass -File .\install-autostart.ps1 -NoSleep`
  (`-NoSleep` oprește sleep/hibernarea pe priză). Dezinstalare: `uninstall-autostart.ps1`.

Din alt dispozitiv din rețea: `http://192.168.100.179:8080`.

## Acces de oriunde: Tailscale Funnel

Conexiunea Digi este în spatele CGNAT (IP WAN router 100.71.13.75), deci port forwarding-ul nu poate funcționa.
Accesul din internet se face prin **Tailscale Funnel**:

- adresă publică: **https://camera-nvr.tailddc911.ts.net** (certificat Let's Encrypt valid, fără avertizări)
- merge din orice browser (telefon, laptop), fără aplicație instalată pe telefon
- Tailscale rulează ca serviciu Windows și pornește singur; configurația Funnel e persistentă
- Funnel trimite traficul către `http://127.0.0.1:8081` (port local, inaccesibil din rețea); login-ul aplicației rămâne obligatoriu
- comenzi utile: `tailscale funnel status`, oprire: `tailscale funnel --https=443 off`,
  repornire: `tailscale funnel --bg http://127.0.0.1:8081`
- vorbirea prin cameră (WebRTC) nu trece prin Funnel; din afara casei necesită aplicația Tailscale pe telefon

## Acces din internet și securitate

- Clientul web rulează pe **HTTPS** pe portul 8080 (certificat în `C:\TapoNVR\tls`); cererile `http://` sunt redirecționate.
- **Autentificare obligatorie** pentru orice acces care nu vine de pe acest PC (localhost):
  pagină de login, sesiune 30 de zile (cookie HttpOnly/Secure), IP blocat 15 min după 5 parole greșite.
  Datele inițiale: `C:\TapoNVR\CREDENTIALE.txt`. Schimbare: `node set-password.js admin <parola-noua>`, apoi repornire.
- Dacă nu există niciun utilizator, accesul e permis **doar din rețeaua locală**.
- Router: port forwarding TCP 8080 extern → 192.168.100.179:8080, cu **„External source port” gol**.
  Nu redirecționa niciodată porturile camerei (554, 2020, 443, 8800).
- Certificatul e auto-semnat: browserul afișează o avertizare la prima vizită („Avansat → Continuă”).

## Structură pe disc

```
C:\TapoNVR\recordings\2026-11-08\2026-11-08_14-05-00.mp4   (fișiere MP4 standard)
C:\TapoNVR\live\                                           (buffer live temporar)
C:\TapoNVR\logs\nvr.log
```

## Fiabilitate

- ffmpeg e repornit automat dacă se pierde conexiunea (backoff 2 s → 60 s)
- dacă nu mai sosesc date timp de 40 s, procesul este repornit
- sarcina programată repornește aplicația dacă se oprește
- segmentul în curs se scrie ca MP4 fragmentat (fragmente de 10 s): la pană de curent / crash
  se pierd cel mult ~10 s, iar segmentul în curs poate fi redat din arhivă imediat
- după închidere, fiecare segment e rescris automat (fără re-encodare) ca MP4 standard cu index
  la început → pornire și derulare instantanee în browser
- fișierele care nu pot fi citite sunt ascunse din arhivă (marcate în `.durations.json`)

## Spațiu estimat

Măsurat pe această cameră: `stream1` 2880×1620 ≈ 1,4 Mbps → **~15 GB/zi**. 30 de zile ≈ 450 GB.
Cu ~175 GB liberi încap ~10 zile; `minFreeGB` șterge automat cele mai vechi fișiere când discul se umple.
