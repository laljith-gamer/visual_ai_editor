import { BASE_PROMPT } from "./base";
import { PLAN_PROMPT } from "./plan";
import { MOMENT_PROMPT } from "./moment";
import { EXTRACT_PROMPT } from "./extract";
import { DESCRIBE_PROMPT } from "./describe";
import { EDIT_PROMPT } from "./edit";
import { ACKNOWLEDGE_PROMPT } from "./acknowledge";
import { BRIEFING_PROMPT } from "./briefing";
import { PROMOTE_PROMPT } from "./promote";
import { MERGE_PROMPT } from "./merge";
import { COMPOSE_PROMPT } from "./compose";
import { CLARIFY_PROMPT } from "./clarify";
import { TAXONOMY_PROMPT } from "./taxonomy";
import { AUTOMODE_PROMPT } from "./autoMode";
import { DURATION_PROMPT } from "./duration";
import { FACTS_PROMPT } from "./facts";
import { ANTILOOP_PROMPT } from "./antiLoop";
import { LIBRARY_PROMPT } from "./library";
import { SCHEMA_PROMPT } from "./schema";

export const PLANNER_SYSTEM_PROMPT = [
  BASE_PROMPT,
  PLAN_PROMPT,
  MOMENT_PROMPT,
  EXTRACT_PROMPT,
  DESCRIBE_PROMPT,
  EDIT_PROMPT,
  ACKNOWLEDGE_PROMPT,
  BRIEFING_PROMPT,
  PROMOTE_PROMPT,
  MERGE_PROMPT,
  COMPOSE_PROMPT,
  CLARIFY_PROMPT,
  TAXONOMY_PROMPT,
  AUTOMODE_PROMPT,
  DURATION_PROMPT,
  FACTS_PROMPT,
  ANTILOOP_PROMPT,
  LIBRARY_PROMPT,
  SCHEMA_PROMPT
].join('\n\n');
