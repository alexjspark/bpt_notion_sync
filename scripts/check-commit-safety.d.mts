export interface CommitSafetyProblem {path:string;reason:string}
export function inspectStagedChanges(options?:{cwd?:string;forbiddenValues?:string[]}):{passed:boolean;stagedFiles:number;problems:CommitSafetyProblem[]};
