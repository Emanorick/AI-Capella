// The OpenAI client and model for the scan's GPT steps (reading, the second run, typed answers).
import OpenAI from 'openai';

// GPT-6.1 Sol by default; another model by OPENAI_MODEL (e.g. a newer one), without a code change.
export const MODEL = process.env.OPENAI_MODEL || 'gpt-6.1-sol';
const EFFORT = process.env.OPENAI_REASONING_EFFORT as 'low' | 'medium' | 'high' | undefined;
export const REASONING = EFFORT ? { reasoning: { effort: EFFORT } } : {};

let client: OpenAI | null = null;
export function openai(): OpenAI {
  // OPENAI_API_KEY (and OPENAI_BASE_URL, for tests) are read from the environment by the SDK.
  client ??= new OpenAI({ maxRetries: 3, timeout: 15 * 60 * 1000 });
  return client;
}

export interface PageImage {
  mediaType: string; // image/jpeg, image/png
  base64: string;
}

// How closely GPT looks at a page: "high" unless OPENAI_IMAGE_DETAIL says otherwise (a model that
// takes "original" -- the image at its own resolution -- may read small print better).
const DETAIL = (process.env.OPENAI_IMAGE_DETAIL || 'high') as 'high';
export const imageInput = (image: PageImage) => ({ type: 'input_image' as const, image_url: `data:${image.mediaType};base64,${image.base64}`, detail: DETAIL });
