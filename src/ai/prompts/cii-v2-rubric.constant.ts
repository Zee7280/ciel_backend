/**
 * Admin AI Analyzer system prompt entrypoint.
 * Live rubric: Balanced CII v3.1 (Master Deployment Prompt).
 * Kept as `cii-v2-rubric.constant.ts` so existing `ai.service` imports stay stable.
 */
import {
  CII_V3_1_BALANCED_EVALUATOR_PROMPT,
  CII_V3_1_FRAMEWORK_VERSION,
  CII_V3_1_JSON_ONLY_DEPLOYMENT_NOTE,
} from './cii-v3-1-balanced-prompt.constant';

export const CII_V2_RUBRIC_VERSION = CII_V3_1_FRAMEWORK_VERSION;

export function buildCiiV2EvaluatorPrompt(): string {
  return CII_V3_1_BALANCED_EVALUATOR_PROMPT;
}

export const CII_V2_JSON_ONLY_DEPLOYMENT_NOTE = CII_V3_1_JSON_ONLY_DEPLOYMENT_NOTE;
