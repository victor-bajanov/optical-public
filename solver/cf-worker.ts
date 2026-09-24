import { Container, getContainer } from "@cloudflare/containers";

export class SolverContainer extends Container {
  defaultPort = 8080;
  sleepAfter = "30s";
}

interface Env {
  SOLVER_CONTAINER: DurableObjectNamespace<SolverContainer>;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return getContainer(env.SOLVER_CONTAINER).fetch(request);
  },
};
