import { z } from "zod";
import { IsoDateTime } from "./common";
import { D } from "./descriptions";

export const ProjectCreate = z.object({
  title: z.string().min(1).max(500).describe(D.project.title),
  deadline: IsoDateTime.describe(D.project.deadline).nullable().optional(),
  priority_floor: z.number().int().min(0).max(100).describe(D.project.priority_floor).optional(),
}).strict();

export type ProjectCreateT = z.infer<typeof ProjectCreate>;

export const ProjectPatch = ProjectCreate.partial();
