# Prehraj.to Stremio Addon (CZ / SK)

Lokálny Stremio doplnok pre filmy a seriály z **prehrajto.cz** so zameraním na CZ/SK obsah, prehľadné zoradenie streamov a „Hellspy feeling“ zobrazenie.

---

## 🔥 Čo tento addon robí

Tento addon umožňuje prehrávať **filmy a seriály z prehrajto.cz** priamo v **Stremiu**:

- funguje **lokálne** (bez cloudu, bez Renderu)
- podporuje **PC aj Android box** v rovnakej sieti (LAN / Wi-Fi)
- zobrazuje streamy prehľadne a čitateľne
- triedi streamy inteligentne podľa kvality a veľkosti
- zameraný na **CZ / SK dabing a titulky**

---

## 🎬 Podporovaný obsah

- 🎥 **Filmy**
- 📺 **Seriály** (SxxExx, Kodi-štýl párovanie)
- 🇨🇿 🇸🇰 CZ / SK dabing
- 💬 CZ titulky
- 🌍 EN (ak nie je CZ/SK dostupné)

---

## 🧠 Inteligentné zoradenie streamov

Streamy sú zoradené tak, aby najlepšie varianty boli vždy hore:

1. **Kvalita obrazu**
   - 4K
   - FullHD
   - HD
2. **Typ zdroja**
   - HDR
   - BluRay
   - WEB-DL
   - WEBRip
3. **Veľkosť súboru**
   - v rámci rovnakej kvality sa triedi podľa veľkosti
4. **Jazyk**
   - CZ dabing má prioritu
   - SK dabing
   - titulky

Výsledok je veľmi podobný správaniu doplnkov ako **Hellspy / Kodi**.

---

## 🧩 Zobrazenie v Stremiu

Addon zobrazuje streamy v **viacriadkovom formáte**, nie v jednej dlhej vete:

- názov
- kvalita (HD / FHD / 4K)
- typ zdroja (HDR / WEB-DL / BluRay)
- veľkosť súboru
- dĺžka videa

Vďaka tomu je výber streamu rýchly a prehľadný.

---

## 🖥️ Lokálne používanie (PC)

### Požiadavky
- Node.js **18+**
- Stremio Desktop

### Inštalácia
```bash
npm install


## Spustenie addonu

node index.js

```

## Po spustení uvidíš v konzole napríklad:

Prehraj.to addon beží na http://127.0.0.1:7001
Manifest: http://127.0.0.1:7001/manifest.json

```

---

## 📱 Android box / TV (LAN)

Addon nie je cloudový, funguje cez lokálny server.

Postup:

1. PC a Android box musia byť v rovnakej sieti

2. Zisti IP adresu PC (napr. 192.168.1.10)

3. V Stremiu na Androide:

Add addons → Community addons → Install via URL

4. Zadaj:
   ```
   http://192.168.1.10:7001/manifest.json

   ```
## Addon sa nainštaluje a funguje rovnako ako na PC.

---

## 🚀 Automatický štart pri zapnutí PC (Windows)
Najjednoduchší spôsob:

1. Vytvor .bat súbor, napríklad:
  ```
cd C:\cesta\k\prehrajto-stremio
node index.js

  ```
2. Stlač Win + R → zadaj:

  ```
  shell:startup
  
  ```
Addon sa spustí automaticky po štarte Windows.

---

## 📦 Verzie

v2.5.0-local – aktuálna stabilná verzia

iba lokálne používanie

PC + Android box (LAN)

bez Renderu / cloudu

⚠️ Číslo verzie v Stremiu sa nemení automaticky podľa GitHub tagu.
Stremio si pamätá verziu z manifestu – je to normálne správanie.

---

## Poznámka

Tento projekt je určený **na vzdelávacie a experimentálne účely**. Používateľ je zodpovedný za dodržiavanie platnej legislatívy vo svojej krajine.

---

## 📸 Screenshots

Ukážky reálneho zobrazenia v Stremiu:

Filmy

Seriály (SxxExx)

Zoradenie streamov

(Screenshots sú uložené v priečinku /screenshots)

---

## 👤 Autor

Vytvorené a upravované s dôrazom na praktické používanie, rýchlosť a prehľadnosť.
Inšpirácia: Kodi / Hellspy doplnky.

---
##  📄 Licencia

Pozri súbor LICENSE.

 
