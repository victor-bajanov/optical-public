import type { TaskCreateT } from "../schema/task";

export type Task = TaskCreateT & {
  id: string;
  created_at: string;
  updated_at: string;
};
