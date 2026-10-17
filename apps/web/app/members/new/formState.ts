// The state shared by the form (browser) and its Server Action (server).
// It lives in its own file because a "use server" file may only export async
// functions: Next.js turns each one into a callable endpoint.

export interface RegisterFormState {
  error: string | null;
  // What the user typed. It goes back to the form on failure, so a duplicate
  // email means fixing one field rather than retyping everything.
  values: { name: string; email: string; phone: string };
}

export const initialRegisterFormState: RegisterFormState = {
  error: null,
  values: { name: "", email: "", phone: "" },
};
