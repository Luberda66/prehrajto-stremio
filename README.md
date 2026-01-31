# Prehraj.to Stremio Addon (CZ/SK) – Local version

## 📌 Popis
Tento addon pre **Stremio** umožňuje prehrávanie filmov a seriálov zo služby **prehraj.to**.
Táto verzia je určená **iba na lokálne používanie (PC + Android box v rovnakej LAN/Wi‑Fi sieti)**.

Nejde o cloudové riešenie – addon beží ako lokálny Node.js server.

---

## ✅ Vlastnosti
- 🎬 Filmy aj seriály (CZ / SK)
- 🖥️ PC (Windows / Linux)
- 📺 Android box / Android TV (LAN)
- ⚡ Rýchle lokálne odpovede
- ☁️ Bez Renderu, bez cloudu
- 🔒 Bez zdieľania mimo siete

---

## 📦 Požiadavky
- Node.js **v18+**
- Stremio (PC alebo Android)
- Zariadenia v **rovnakej sieti**

---

## ▶️ Spustenie addonu (PC)

```bash
npm install
node index.js
```

Po spustení uvidíš napríklad:
```
Addon beží na: http://192.168.1.100:7001
```

---

## ➕ Inštalácia do Stremia

### PC
1. Otvor Stremio
2. Addons → Community addons
3. Vlož URL:
```
http://127.0.0.1:7001/manifest.json
```

### Android box (LAN)
Použi IP adresu PC:
```
http://192.168.1.100:7001/manifest.json
```

---

## 🔄 Automatický štart po zapnutí PC (Windows)

Vytvor súbor `start-prehrajto.bat`:
```bat
cd C:\cesta\k\addonu
node index.js
```

Pridaj ho do:
```
Win + R → shell:startup
```

---

## 🔢 Verzia
**v2.4.2**  
- stabilná lokálna verzia
- PC + Android LAN
- bez Render / cloud

---

## 📸 Ukážka v Stremio

### 🎬 Film
![Prehraj.to – Movie](screenshots/prehraj.to-movie.png)

### 📺 Seriál
![Prehraj.to – Series](screenshots/prehraj.to-series.png)

---

## ⚠️ Upozornenie
Addon využíva verejne dostupné odkazy.
Používanie je na vlastnú zodpovednosť.

---

## 🧑‍💻 Autor
Luberd66  
CZ / SK komunita

---

## 📜 Licencia
MIT
