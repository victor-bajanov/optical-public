import type { ReplanEmailModel } from "./email-model";

export interface RenderedEmail { subject: string; plaintext: string; html: string }
export interface RenderOpts { acceptUrl: string; planHash: string }

export interface DiffEmailRenderer {
  render(model: ReplanEmailModel, opts: RenderOpts): RenderedEmail;
}
