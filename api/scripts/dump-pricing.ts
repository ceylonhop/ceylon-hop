// Prints the canonical front-end pricing payload as JSON on stdout. Consumed by
// tools/generate-pricing.mjs (root, dependency-free) via `npm run --silent dump:pricing`.
import { buildPricingPayload } from '../src/quote/pricingPayload';

process.stdout.write(JSON.stringify(buildPricingPayload(), null, 2) + '\n');
