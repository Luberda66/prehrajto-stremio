Prehraj.to Stremio Addon (CZ/SK)

Lokálny Stremio doplnok pre vyhľadávanie a prehrávanie filmov a seriálov zo servera prehrajto.cz
Optimalizovaný pre PC aj Android box v jednej LAN sieti.

✨ Čo tento doplnok robí

Tento addon umožňuje:

🔎 Vyhľadávať filmy aj seriály z prehrajto.cz priamo v Stremiu

🎬 Zobrazovať viacero streamov pre jeden titul

🇨🇿🇸🇰 Rozlišovať CZ / SK / EN jazyk

📺 Rozlišovať kvalitu (4K / FULLHD / HD)

📦 Zobrazovať veľkosť súboru, dĺžku a bitrate

🔥 Prehľadné „Hellspy-like“ rozloženie streamov

📶 Funguje lokálne bez cloudu (žiadny Render, žiadny externý server)

🖥️ Lokálny režim (odporúčaná verzia)

Addon beží lokálne na tvojom PC a Stremio k nemu pristupuje:

z PC

z Android boxu / Android TV
➡️ stačí byť v rovnakej Wi-Fi alebo LAN sieti

📦 Verzia

Aktuálna verzia: v2.5.0-local

Typ: Local / LAN

Cloud: ❌ nepoužíva sa

Testované:

Windows PC

Android box (LAN)

⚠️ Číslo verzie, ktoré zobrazuje Stremio (napr. 2.4.2), nemusí zodpovedať GitHub tagu.
Stremio si verziu berie z manifest.version v index.js.

📂 Štruktúra projektu
prehrajto-stremio/
├─ index.js
├─ package.json
├─ package-lock.json
├─ icon.png
├─ README.md
├─ CHANGELOG.md
├─ LICENSE
└─ screenshots/
   ├─ stremio-movie.png
   └─ stremio-series.png

⚙️ Požiadavky

Node.js 18+

NPM

Stremio (PC / Android)

🚀 Inštalácia (lokálne)
1️⃣ Stiahni projekt
git clone https://github.com/Luberda66/prehrajto-stremio.git
cd prehrajto-stremio

2️⃣ Nainštaluj závislosti
npm install

3️⃣ Spusti addon
npm start


V konzole uvidíš napríklad:

🚀 Prehraj.to addon beží na http://0.0.0.0:7001
📄 Manifest: http://0.0.0.0:7001/manifest.json

➕ Inštalácia do Stremio
PC

Otvor Stremio

Addons → Community Addons

Klikni Add addon via URL

Zadaj:

http://127.0.0.1:7001/manifest.json

Android / Android TV

Zisti IP adresu PC (napr. 192.168.1.100)

V Stremiu na Android boxe:

http://192.168.1.100:7001/manifest.json


➡️ PC musí byť zapnuté a addon spustený

📺 Zoradenie streamov (logika)

Streamy sú radené inteligentne, nie len podľa veľkosti:

Kvalita

4K

FULLHD

HD

Jazyk

CZ / SK

EN

Veľkosť súboru (v rámci rovnakej kvality)

Bitrate (jemné doladenie)

➡️ Výsledok je prehľadný zoznam podobný Hellspy.

📸 Screenshoty
🎬 Film

📺 Seriál

🔐 Prihlásenie / účet

❌ Nie je potrebné žiadne konto

❌ Nie je potrebné prihlásenie na prehrajto.cz

Addon používa verejne dostupné stránky

⚠️ Upozornenie

Tento projekt je určený výhradne na študijné a osobné účely.
Autor nenesie zodpovednosť za spôsob použitia doplnku.

📝 Changelog

Pozri súbor CHANGELOG.md

📜 Licencia

MIT License – pozri LICENSE

❤️ Poďakovanie

Stremio komunite

Inšpirácia: Hellspy UI

Testovanie: PC + Android LAN
