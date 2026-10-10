process.loadEnvFile();

import { SarvamAIClient } from "sarvamai";

const apiKey = process.env.SARVAM_API_KEY;
if (!apiKey) {
  console.error("SARVAM_API_KEY is not set in .env");
  process.exit(1);
}

const client = new SarvamAIClient({ apiSubscriptionKey: apiKey });

const response = await client.chat.completions({
  model: "sarvam-105b-conversations",
  messages: [{ role: "user", content: "Say hello in one short sentence." }],
});

console.log(response.choices[0].message.content);
