// A minimal model endpoint for bench --endpoint, to copy and put your own model behind.
// Run: node --import tsx scripts/example-endpoint.ts [port]   (default 8787)
// Then: npm run bench -- --endpoint http://localhost:8787 --games 2
//
// It gets the request jevman sends System One: {state, questions}. Each question is
// {type: 'choice', instructions, criteria: {<direction>: <what that route looks like>}}. Answer every question with
// one of its criteria keys. This "model" just avoids routes marked DANGER or TRAP and takes the first of the rest.
import { createServer } from 'node:http';

interface Question {
  type: 'choice';
  instructions: string;
  criteria: Record<string, string>;
}

function choose(q: Question): string {
  const options = Object.keys(q.criteria);
  return options.find((d) => !/DANGER|TRAP/.test(q.criteria[d])) ?? options[0];
}

const port = Number(process.argv[2] ?? 8787);
createServer((req, res) => {
  let body = '';
  req.on('data', (chunk: Buffer) => (body += chunk));
  req.on('end', () => {
    try {
      const { questions } = JSON.parse(body) as { questions: Record<string, Question> };
      const answers = Object.fromEntries(Object.entries(questions).map(([name, q]) => [name, { type: 'choice', choice: choose(q) }]));
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ answers }));
    } catch {
      res.writeHead(400).end();
    }
  });
}).listen(port, () => console.log(`example endpoint on http://localhost:${port}`));
