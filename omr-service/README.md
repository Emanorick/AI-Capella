# AI-Capella Scan-Dienst (Noten scannen)

Wandelt ein PDF oder bis zu 40 Fotos von Notenseiten in MusicXML um – GPT liest die Noten selbst
(Modell `gpt-6.1-sol`, einstellbar über `OPENAI_MODEL`):

1. **Noten lesen:** GPT liest Seite 1 (sie legt die Stimmen fest), dann die übrigen Seiten, ein paar
   gleichzeitig: alle Takte aller Stimmen mit dem Text jeder Strophe, Takt- und Tonartwechsel,
   Wiederholungen (auch „3x“), Volten, Probenbuchstaben, Tempo, D.C./D.S./Coda/Fine – und wo jeder
   Takt auf der Seite steht.
2. **Zusammensetzen:** Stehen mehrere Strophen untereinander, wird die Stelle zur Wiederholung, die so
   oft gespielt wird, wie es Strophen gibt (Strophe 1 beim ersten Durchgang, Strophe 2 beim zweiten …).
3. **Plausibilitätsprüfung** (ohne GPT): Takte, die nicht aufgehen, Töne außerhalb des Stimmumfangs,
   Sprünge über eine Oktave, Haltebögen zu einem anderen Ton, abgebrochene Wörter.
4. **Zweiter Durchgang:** GPT prüft jede Seite nochmal mit dem Bild und schaut besonders auf die
   auffälligen Takte; korrigiert Noten, Textlesefehler, fehlende Wiederholungen und Zeichen. Eine
   Korrektur wird nur übernommen, wenn der Takt danach in jeder Stimme aufgeht.
5. **Rückfragen:** Wo GPT dann noch unsicher ist, fragt die App nach – mit Ausschnitt der Stelle,
   Auswahl und Freitextfeld. Was offen bleibt, wird im Stück als „zu prüfende Stelle“ markiert.

(Mit `OMR_ENGINE=audiveris` und `Dockerfile.audiveris` liest stattdessen Audiveris, und GPT prüft
nur – der frühere Weg.)

Die App (GitHub Pages) lädt die Seiten hoch, zeigt den Fortschritt und übernimmt das Ergebnis ins
Repertoire. Der Dienst läuft als Container auf **Google Cloud Run** im Firebase-Projekt `ai-capella`.

Der Dienst läuft entweder auf einem **eigenen Server** (Docker, siehe direkt unten) oder auf
**Google Cloud Run** (weiter unten). Die App merkt keinen Unterschied.

## Variante A: eigener Server (Docker)

### Voraussetzungen

- Ein Linux-Server, auch ein kleiner: **1 GB RAM** und 1 GB freier Speicher reichen, ARM (z. B.
  Raspberry Pi 4/5) geht auch – die Arbeit macht GPT bei OpenAI.
- **Docker** mit dem Compose-Plugin (`docker compose version` muss etwas ausgeben;
  Installation: docs.docker.com/engine/install).
- Eine **(Sub-)Domain**, die auf den Server zeigt, z. B. `scan.mein-chor.de` (beim Domain-Anbieter
  einen A-Eintrag auf die IP des Servers anlegen), und die Ports **80 und 443** müssen von außen
  erreichbar sein (ggf. im Router/Firewall freigeben). Darüber holt Caddy automatisch ein
  HTTPS-Zertifikat. HTTPS ist Pflicht: die App läuft auf GitHub Pages über HTTPS, und Browser
  blockieren Aufrufe an unverschlüsselte Adressen.
- Ein OpenAI-API-Key (platform.openai.com → API keys).

### Einrichten

```sh
git clone https://github.com/Emanorick/AI-Capella.git
cd AI-Capella/omr-service
git checkout claude/amazing-bardeen-c4fcke
cp .env.example .env
nano .env        # OMR_DOMAIN und OPENAI_API_KEY eintragen (OPENAI_MODEL steht auf gpt-6.1-sol)
docker compose up -d --build
```

Das erste Bauen dauert ein, zwei Minuten. Prüfen:

```sh
curl https://scan.mein-chor.de/healthz
# {"ok":true,"engine":"gpt","review":true,"maxPages":40}
docker compose logs -f omr     # laufende Protokolle
```

Dann die App verbinden wie in Schritt 5 unten beschrieben (GitHub-Variable `OMR_URL` =
`https://scan.mein-chor.de`).

**Aktualisieren:**

```sh
git pull
docker compose build --pull     # --pull: holt das neueste Node-Grundimage (Sicherheits-Updates)
docker compose pull caddy
docker compose up -d
```

Fertige Scans bleiben dabei erhalten (sie liegen im Docker-Volume `omr-jobs`); nur ein gerade
laufender Scan geht verloren. Ohne `--pull` nimmt Docker ein altes Grundimage aus seinem Speicher;
ist dessen Node älter als 24.22.1 (ohne die Korrektur der Zertifikatsliste vom Oktober 2026,
eMudhra), bricht der Bau mit einem Hinweis ab.

**Keine Domain oder keine offenen Ports?** Dann geht es auch mit einem Cloudflare Tunnel
(kostenlos, gibt eine HTTPS-Adresse ohne Portfreigabe) statt Caddy – sag Bescheid, dann baue ich
die Variante dazu.

**Kosten:** nur die OpenAI-Aufrufe (siehe „Kosten“ unten); der Server selbst läuft ja ohnehin.

## Variante B: Google Cloud Run (einmalig, ca. 20 Minuten)

Du brauchst: Zugang zum Firebase-/Google-Cloud-Projekt `ai-capella`, einen OpenAI-API-Key
(platform.openai.com → API keys) und Admin-Rechte im GitHub-Repo.

### 1. Blaze-Tarif

Cloud Run braucht ein Abrechnungskonto: Firebase-Konsole → Projekt `ai-capella` → unten links
„Upgrade“ → **Blaze**. Empfehlung: gleich ein Budget mit E-Mail-Warnung setzen (z. B. 10 €/Monat)
unter console.cloud.google.com → Abrechnung → Budgets & Benachrichtigungen.

### 2. Cloud Shell öffnen

console.cloud.google.com → oben das Projekt `ai-capella` wählen → rechts oben das Terminal-Symbol
(**Cloud Shell**). Dort ist alles Nötige schon installiert. Dann:

```sh
git clone https://github.com/Emanorick/AI-Capella.git
cd AI-Capella/omr-service
git checkout claude/amazing-bardeen-c4fcke
gcloud config set project ai-capella
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com
```

### 3. OpenAI-Key als Secret hinterlegen

```sh
read -s -p "OpenAI API key: " KEY && printf '%s' "$KEY" | gcloud secrets create openai-api-key --data-file=- && unset KEY
PROJECT_NUMBER=$(gcloud projects describe ai-capella --format='value(projectNumber)')
gcloud secrets add-iam-policy-binding openai-api-key \
  --member="serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
  --role=roles/secretmanager.secretAccessor
```

Der Key steht damit nirgends im Code oder im Repo.

### 4. Dienst bauen und starten

```sh
gcloud run deploy ai-capella-omr --source . --region europe-west3 \
  --memory 1Gi --cpu 1 --timeout 3600 --concurrency 20 \
  --min-instances 0 --max-instances 1 --no-cpu-throttling \
  --allow-unauthenticated \
  --set-secrets OPENAI_API_KEY=openai-api-key:latest \
  --set-env-vars "^;^ALLOWED_ORIGINS=https://emanorick.github.io;OPENAI_MODEL=gpt-6.1-sol;FIREBASE_PROJECT_ID=ai-capella"
```

Beim ersten Mal fragt gcloud eventuell, ob ein „Artifact Registry“-Repository angelegt werden soll:
mit `Y` bestätigen. Das Bauen dauert ein paar Minuten.
Am Ende steht die **Service URL** da, z. B. `https://ai-capella-omr-abc123-ey.a.run.app`.

Prüfen:

```sh
curl https://…deine-service-url…/healthz
# {"ok":true,"engine":"gpt","review":true,"maxPages":40}
```

`"ok": false, "review": false` hieße: der OpenAI-Key ist nicht angekommen (Schritt 3 prüfen) – dann
nimmt der Dienst keine Scans an.

### 5. Die App mit dem Dienst verbinden

GitHub → Repo `AI-Capella` → **Settings → Secrets and variables → Actions → Variables** →
„New repository variable“: Name `OMR_URL`, Wert: die Service URL (ohne `/` am Ende).
Dann **Actions → Deploy to GitHub Pages → Run workflow**. Danach bietet „Arrangement hinzufügen“
zusätzlich **„Noten scannen (PDF, Fotos)“** an.

## Aktualisieren (Cloud Run)

In der Cloud Shell: `cd AI-Capella && git pull && cd omr-service` und Schritt 4 wiederholen.
Cloud Build baut dabei jedes Mal mit dem aktuellen Node-Grundimage – Sicherheits-Updates von Node
(wie die korrigierte Zertifikatsliste vom Oktober 2026) kommen so mit jedem neuen Deploy mit.
Anderes Modell: `OPENAI_MODEL=…` in Schritt 4 ändern (z. B. ein neueres GPT-Modell). Optional
`OPENAI_REASONING_EFFORT=low|medium|high` für Modelle mit einstellbarem Denkaufwand (für Noten
lohnt sich `high`), `OPENAI_IMAGE_DETAIL=original`, wenn das Modell Bilder in voller Auflösung
annimmt (hilft bei kleinem Notenstich), `REVIEW_CONCURRENCY` (Standard 4) für die Zahl der Seiten,
die gleichzeitig gelesen werden.

## Kosten (grobe Schätzung)

- **Cloud Run**: nur solange ein Scan läuft (plus bis zu ~15 Minuten danach), ca. 0,16 € pro Stunde
  → wenige Cent pro Scan. Ohne Scans: 0 €.
- **OpenAI**: pro Seite zwei Aufrufe mit Bild (Lesen und zweiter Durchgang), dazu einer pro
  Rückfrage, die frei beantwortet wird. Je nach Modell und Notendichte grob 5–25 Cent pro Seite,
  bei 40 Seiten also etwa 2–10 €. Die genauen Preise von GPT-6.1 stehen auf openai.com/api/pricing.

## Sicherheit und Grenzen

- Nur Geräte, die in der App angemeldet sind (Firebase-Anmeldung, wie für die Bibliothek), können
  Scans starten; jeder Scan ist nur für das Gerät sichtbar, das ihn gestartet hat. Anfragen werden
  nur von `ALLOWED_ORIGINS` (der GitHub-Pages-Adresse) angenommen. Höchstens 2 laufende Scans pro Gerät.
- Wird der Dienst neu gestartet (z. B. durch ein Update), geht ein gerade laufender Scan verloren,
  und die App sagt Bescheid. Fertige Ergebnisse werden auf der Platte gespeichert und bleiben
  6 Stunden abrufbar (auf Cloud Run nur bis zum nächsten Neustart des Containers).
- Fotos werden in der App auf max. 3000 px verkleinert; ein PDF darf höchstens 30 MB haben.
- Scans werden nacheinander verarbeitet; innerhalb eines Scans liest GPT ein paar Seiten gleichzeitig.
- Rückfragen müssen innerhalb der 6 Stunden beantwortet werden, solange der Scan auf dem Server liegt.

## Entwickeln und testen (ohne OpenAI)

Node 24 ab 24.22.1 (oder 22 ab 22.23.4) – ältere Versionen haben noch die alte Zertifikatsliste.

```sh
npm install
npm test                         # Unit-Tests + kompletter API-Ablauf mit Platzhaltern
node test/mocks/run-local.mjs    # Dienst auf :18090 mit Platzhaltern für OpenAI und die PDF-Werkzeuge
# in einem zweiten Terminal, im Hauptordner:
VITE_OMR_URL=http://localhost:18090 npx vite --port 5201
```

Die Platzhalter (`test/mocks/`) „lesen“ immer Evening Rise (mit zwei absichtlichen Lesefehlern, die
der zweite Durchgang behebt), stellen eine Rückfrage pro Seite und lassen eine Stelle offen; damit
lassen sich Upload, Fortschritt, Rückfragen, Bericht und Import durchspielen. Wie gut GPT-6.1 echte
Noten liest, zeigt nur ein Versuch mit echtem Schlüssel und echten Seiten.

Aufbau: `src/server.ts` (HTTP-API), `src/pipeline.ts` (Ablauf eines Scans, Rückfragen),
`src/transcribe.ts` (GPT liest eine Seite; Seiten zusammensetzen), `src/notation.ts`
(Kompaktnotation), `src/build.ts` (MusicXML daraus), `src/checks.ts` (Plausibilitätsprüfung),
`src/review.ts` (zweiter Durchgang, freie Antworten), `src/score.ts` (MusicXML lesen, Korrekturen
zurückschreiben), `src/ai.ts` (OpenAI-Zugang, Modell).

API: `POST /jobs` · `PUT /jobs/:id/files/:n` · `POST /jobs/:id/start` · `GET /jobs/:id` (Fortschritt,
Bericht, Rückfragen, zu prüfende Stellen) · `GET /jobs/:id/result` (MusicXML) ·
`GET /jobs/:id/pages/:n` (Seitenbild) · `POST /jobs/:id/answers` (`{answers: [{id, choice | text | skip}]}`).
