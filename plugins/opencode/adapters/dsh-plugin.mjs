// The Cordis plugin plugins/dsh/cordis.patch.yml mounts. The one line that needs dsh's own package lives here, so the
// listeners in dsh-host.mjs can run under test without an installed harness.
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { applyEstelle } from './dsh-host.mjs';

export const name = 'estelle';
export const inject = ['agents'];

export function apply(ctx) {
  applyEstelle(ctx, { createUserMessage });
}
