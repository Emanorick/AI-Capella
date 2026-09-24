// Stand-in for the OpenAI Responses API in local tests: on each page it "corrects" the first
// sung note of the first part (to C#5) and proposes one broken correction that must be refused.
import { createServer } from 'node:http';
export const calls = [];
export function startFakeOpenAI(port) {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const request = JSON.parse(body);
        const text = request.input[0].content.find((c) => c.type === 'input_text').text;
        const hasImage = request.input[0].content.some((c) => c.type === 'input_image' && c.image_url.startsWith('data:image/jpeg;base64,'));
        const payload = JSON.parse(text.slice(text.indexOf('\n') + 1));
        calls.push({ model: request.model, hasImage, schema: request.text?.format?.name, measures: payload.measures.map((m) => m.m) });
        const part = payload.parts[0].id;
        const first = payload.measures[0];
        const notes = first.parts[part].map((n) => ({ ...n }));
        const i = notes.findIndex((n) => n.p !== 'rest');
        notes[i].p = 'C#5';
        const answer = {
          corrections: [
            { part, m: first.m, reason: 'Kreuz übersehen', notes },
            { part, m: first.m + 1, reason: 'kaputt', notes: notes.slice(0, 1) },
          ],
          partNames: first.m === 1 ? [{ part, name: 'Sopran' }] : [],
          title: first.m === 1 ? 'Evening Rise (geprüft)' : '',
          confidence: 'high',
          remarks: '',
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'resp_test', object: 'response', created_at: 0, status: 'completed', model: request.model,
          output: [{ type: 'message', id: 'msg_test', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(answer), annotations: [] }] }],
        }));
      });
    });
    server.listen(port, () => resolve(server));
  });
}
