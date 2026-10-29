// The state shared by the Archive button (browser) and its Server Action
// (server). Its own file for the same reason as new/formState.ts: a
// "use server" file may only export async functions.

export interface ArchiveState {
  error: string | null;
}

export const initialArchiveState: ArchiveState = { error: null };
