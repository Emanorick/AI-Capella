# AI-Capella Scan-Dienst (Noten scannen)

Wandelt ein PDF oder bis zu 40 Fotos von Notenseiten in MusicXML um:

1. **Audiveris** (Open-Source-Notenerkennung) liest alle Seiten als ein Stück.
2. **GPT** (OpenAI) bekommt jede Seite als Bild zusammen mit dem, was Audiveris gelesen hat, und
   schlägt für falsch gelesene Takte den vollständigen korrigierten Takt vor.
3. Eine Korrektur wird nur übernommen, wenn der Takt danach in jeder Stimme aufgeht
   (sonst bleibt Audiveris' Lesart stehen, und der Bericht zeigt den Vorschlag als „nicht übernommen“).

Die App (GitHub Pages) lädt die Seiten hoch, zeigt den Fortschritt und übernimmt das Ergebnis ins
Repertoire. Der Dienst läuft als Container auf **Google Cloud Run** im Firebase-Projekt `ai-capella`.

## Einrichtung (einmalig, ca. 20 Minuten)

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
  --memory 4Gi --cpu 2 --timeout 3600 --concurrency 20 \
  --min-instances 0 --max-instances 1 --no-cpu-throttling \
  --allow-unauthenticated \
  --set-secrets OPENAI_API_KEY=openai-api-key:latest \
  --set-env-vars "^;^ALLOWED_ORIGINS=https://emanorick.github.io;OPENAI_MODEL=gpt-5;FIREBASE_PROJECT_ID=ai-capella"
```

Beim ersten Mal fragt gcloud eventuell, ob ein „Artifact Registry“-Repository angelegt werden soll:
mit `Y` bestätigen. Das Bauen dauert beim ersten Mal ca. 10 Minuten (Audiveris wird heruntergeladen).
Am Ende steht die **Service URL** da, z. B. `https://ai-capella-omr-abc123-ey.a.run.app`.

Prüfen:

```sh
curl https://…deine-service-url…/healthz
# {"ok":true,"review":true,"maxPages":40}
```

`"review": false` hieße: der OpenAI-Key ist nicht angekommen (Schritt 3 prüfen).

### 5. Die App mit dem Dienst verbinden

GitHub → Repo `AI-Capella` → **Settings → Secrets and variables → Actions → Variables** →
„New repository variable“: Name `OMR_URL`, Wert: die Service URL (ohne `/` am Ende).
Dann **Actions → Deploy to GitHub Pages → Run workflow**. Danach bietet „Arrangement hinzufügen“
zusätzlich **„Noten scannen (PDF, Fotos)“** an.

## Aktualisieren

In der Cloud Shell: `cd AI-Capella && git pull && cd omr-service` und Schritt 4 wiederholen.
Anderes Modell: `OPENAI_MODEL=…` in Schritt 4 ändern (z. B. ein neueres GPT-Modell). Optional
`OPENAI_REASONING_EFFORT=low|medium|high` für Modelle mit einstellbarem Denkaufwand.

## Kosten (grobe Schätzung)

- **Cloud Run**: nur solange ein Scan läuft (plus bis zu ~15 Minuten danach), ca. 0,16 € pro Stunde
  → wenige Cent pro Scan. Ohne Scans: 0 €.
- **OpenAI**: pro Seite ein Aufruf mit Bild; je nach Modell und Notendichte grob 2–10 Cent pro Seite,
  also bei 40 Seiten etwa 1–4 €.

## Sicherheit und Grenzen

- Nur Geräte, die in der App angemeldet sind (Firebase-Anmeldung, wie für die Bibliothek), können
  Scans starten; jeder Scan ist nur für das Gerät sichtbar, das ihn gestartet hat. Anfragen werden
  nur von `ALLOWED_ORIGINS` (der GitHub-Pages-Adresse) angenommen. Höchstens 2 laufende Scans pro Gerät.
- Laufende Scans liegen im Speicher des einen Containers: wird er neu gestartet (z. B. durch ein
  Update), gehen laufende Scans verloren, und die App sagt Bescheid. Fertige Ergebnisse bleiben
  6 Stunden abrufbar.
- Fotos werden in der App auf max. 3000 px verkleinert; ein PDF darf höchstens 30 MB haben.
- Scans werden nacheinander verarbeitet (Audiveris braucht den ganzen Rechner).

## Entwickeln und testen (ohne Audiveris und OpenAI)

```sh
npm install
npm test                         # Unit-Tests + kompletter API-Ablauf mit Platzhaltern
node test/mocks/run-local.mjs    # Dienst auf :18090 mit Platzhaltern für Audiveris und OpenAI
# in einem zweiten Terminal, im Hauptordner:
VITE_OMR_URL=http://localhost:18090 npx vite --port 5201
```

Die Platzhalter (`test/mocks/`) „erkennen“ immer Evening Rise und „korrigieren“ einen Ton pro
Seite; damit lassen sich Upload, Fortschritt, Bericht und Import durchspielen.

Aufbau: `src/server.ts` (HTTP-API), `src/pipeline.ts` (Ablauf eines Scans, Audiveris-Aufruf),
`src/review.ts` (GPT-Prüfung), `src/score.ts` (MusicXML: Seiten, Kompaktnotation, Korrekturen).
