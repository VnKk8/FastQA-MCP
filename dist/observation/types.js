// Shared contracts of the observation, correlation and quality layers.
// Observations are facts. Associations state how an observation relates to an action and how sure that is.
// Findings are derived candidates: they never claim a confirmed product defect.
export const SEVERITIES = ['info', 'low', 'medium', 'high'];
export const sevRank = (s) => SEVERITIES.indexOf(s);
