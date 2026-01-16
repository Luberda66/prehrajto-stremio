# Prehraj.to Stremio Addon (CZ/SK)

## O projekte

Tento projekt je **komunitný doplnok pre Stremio**, ktorý prepája Stremio s webom **https://prehrajto.cz**. Jeho úlohou je nájsť a sprostredkovať **priame video streamy** (filmy aj seriály) z Prehraj.to priamo do Stremia – bez potreby manuálneho vyhľadávania v prehliadači.

Doplnok funguje ako „most“ medzi:
- **Cinemeta / TMDb (IMDB ID)** – odkiaľ Stremio získa názov, rok, sezónu a epizódu
- **prehrajto.cz** – kde sa reálne nachádzajú video súbory

Inšpiráciou pre vznik tohto doplnku bol:
- pôvodný **KODI doplnok pre prehraj.to**
- vizuálny a informačný štýl doplnku **Hellspy** (prehľadné streamy, ikony, technické info)

---

## Funkcie doplnku

- 🎬 **Filmy** – vyhľadávanie podľa názvu a roka
- 📺 **Seriály** – plná podpora epizód (S01E01, 1x01, párovanie podľa IMDB → TMDb)
- 🔎 **Automatické vyhľadávanie** na prehrajto.cz
- 🔗 **Priame video URL** (žiadne medzistránky)
- 🇨🇿 🇸🇰 **Rozpoznanie jazyka** (CZ / SK / EN, dabing, titulky)
- 🖥️ **Rozpoznanie kvality** (4K, FULLHD, HD, SD)
- 🌈 **Rozpoznanie formátu** (HDR, BluRay, WEB-DL, WEBRip, REMUX)
- 💾 **Veľkosť súboru**
- ⚡ **Odhadovaný bitrate (Mbps)**
- ⏱ **Dĺžka videa**
- 🔥 **Inteligentné triedenie streamov**:
  - najprv kvalita (4K → FULLHD → HD)
  - potom formát (HDR / BluRay / WEB-DL)
  - až následne veľkosť a bitrate
- 🎨 **Hellspy-like zobrazenie** (viacriadkový blok s ikonami)
- 🧠 **Cache** – menej requestov, rýchlejšie odpovede

---

## Lokálna inštalácia (vývoj / testovanie)

> Tento repozitár je nastavený na **lokálne používanie**. Pri nasadení na cloud (Render/VPS) vie prehrajto.cz často vracať „protection page“, takže scraping potom zlyhá a streamy budú prázdne.

Doplnok je navrhnutý tak, aby sa dal **spúšťať lokálne** na tvojom počítači a testovať priamo v Stremiu.

### Požiadavky
- Node.js (odporúčané LTS)
- npm

### Inštalácia závislostí

V koreňovom priečinku projektu spusti:

```bash
npm install
