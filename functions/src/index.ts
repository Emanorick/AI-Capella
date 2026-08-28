import { onRequest } from 'firebase-functions/v2/https';
import { defineSecret } from 'firebase-functions/params';
import Anthropic from '@anthropic-ai/sdk';

// Set once per environment: `firebase functions:secrets:set ANTHROPIC_API_KEY`
const anthropicApiKey = defineSecret('ANTHROPIC_API_KEY');

// Claude Opus 5 -- the most capable current model, and this is exactly the kind of precise,
// structural visual-reading task worth spending the extra accuracy on (an OMR spike, not a
// latency-sensitive chat route).
const MODEL = 'claude-opus-5';

const SUPPORTED_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

const OMR_PROMPT = `You are an expert music engraver and MusicXML transcriber. You will be shown one page of a choir score (e.g. SATB or SSAATTB) as an image. Transcribe it into MusicXML (version 4.0, partwise) as precisely as possible.

Requirements:
- Include every vocal part visible on the page (e.g. Soprano, Alto, Tenor, Bass -- the exact number of staves varies by piece) as separate <part> elements, each with its own <score-part> in <part-list>.
- Preserve the key signature, time signature, and any changes to either within the page.
- Preserve rhythm exactly: note durations, dotted notes, ties, rests.
- Preserve pitch spelling (including accidentals) as printed -- don't silently "correct" enharmonic spelling.
- Include lyrics as <lyric><text> under each syllable/note where visible.
- Number measures sequentially starting from the page's first measure, unless printed measure numbers are visible and differ.
- If a passage is genuinely ambiguous (smudged print, obscured notation), make your best reading rather than omitting the note, but keep the result musically plausible -- each measure's note (and rest) durations should sum to the time signature.

Output ONLY the raw MusicXML document -- no explanation, no markdown code fences, no commentary before or after. Start directly with <?xml version="1.0" encoding="UTF-8"?> and the <score-partwise> root element.`;

/** Strips a markdown code fence if the model wrapped its output in one despite instructions not to. */
function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:xml)?\n([\s\S]*?)\n```$/);
  return fenced ? fenced[1].trim() : trimmed;
}

/**
 * OMR pipeline spike (Round 4): one page image in, one MusicXML transcription out, via a single
 * Claude vision call -- no OMR engine (Audiveris), no image preprocessing, no per-voice chunking.
 * The point is to find out how far a vision-LLM-only approach gets before investing in any of
 * that. Validation (music21, comparing against the actual source) happens on the caller's side,
 * not here.
 *
 * Request:  POST { imageBase64: string (no "data:" prefix), mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif" }
 * Response: 200, Content-Type: application/xml, body = the MusicXML document
 */
export const omrTestPage = onRequest(
  { secrets: [anthropicApiKey], timeoutSeconds: 300, memory: '512MiB', cors: true },
  async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Use POST.' });
      return;
    }

    const { imageBase64, mediaType } = req.body ?? {};
    if (typeof imageBase64 !== 'string' || !imageBase64) {
      res.status(400).json({ error: 'Missing "imageBase64" (base64-encoded image, no "data:" prefix).' });
      return;
    }
    if (typeof mediaType !== 'string' || !SUPPORTED_MEDIA_TYPES.has(mediaType)) {
      res.status(400).json({ error: `"mediaType" must be one of: ${Array.from(SUPPORTED_MEDIA_TYPES).join(', ')}.` });
      return;
    }

    const client = new Anthropic({ apiKey: anthropicApiKey.value() });

    try {
      const response = await client.messages.create({
        model: MODEL,
        max_tokens: 16000,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: mediaType as Anthropic.Base64ImageSource['media_type'], data: imageBase64 } },
              { type: 'text', text: OMR_PROMPT },
            ],
          },
        ],
      });

      if (response.stop_reason === 'refusal') {
        res.status(502).json({ error: 'Claude declined this request.', stopDetails: response.stop_details });
        return;
      }
      if (response.stop_reason === 'max_tokens') {
        res.status(502).json({ error: 'Response was cut off at the max_tokens limit -- the page likely produced more MusicXML than fit. Try a simpler/shorter page, or raise max_tokens in functions/src/index.ts.' });
        return;
      }

      const textBlock = response.content.find((block): block is Anthropic.TextBlock => block.type === 'text');
      if (!textBlock) {
        res.status(502).json({ error: 'No text content in the response.' });
        return;
      }

      const musicXml = stripCodeFence(textBlock.text);
      res.status(200).set('Content-Type', 'application/xml').send(musicXml);
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError) {
        res.status(500).json({ error: 'Invalid Anthropic API key -- check the ANTHROPIC_API_KEY secret.' });
      } else if (err instanceof Anthropic.RateLimitError) {
        res.status(429).json({ error: 'Rate limited by the Anthropic API -- retry shortly.' });
      } else if (err instanceof Anthropic.APIError) {
        res.status(502).json({ error: `Anthropic API error (${err.status}): ${err.message}` });
      } else {
        res.status(500).json({ error: err instanceof Error ? err.message : 'Unknown error' });
      }
    }
  },
);
