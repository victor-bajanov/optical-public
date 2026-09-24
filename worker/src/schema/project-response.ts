// worker/src/schema/project-response.ts
import { z } from "zod";
import { IsoDateTime } from "./common";
import { D } from "./descriptions";

export const ProjectResponse = z.object({
  id: z.string().uuid().describe(D.response.id),
  created_at: z.string().describe(D.response.created_at),
  updated_at: z.string().describe(D.response.updated_at).optional(),
  title: z.string().min(1).max(500).describe(D.project.title),
  deadline: IsoDateTime.describe(D.project.deadline).nullable().optional(),
  priority_floor: z.number().int().min(0).max(100).describe(D.project.priority_floor).optional(),
});
