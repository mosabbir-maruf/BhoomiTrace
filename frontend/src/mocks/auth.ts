import type {
  DemoRole,
  LoginInput,
  RegisterInput,
  Session,
} from "@/lib/api/types"
import { delay, getMockScenario } from "./service"
import { sampleApplicant, sampleReviewer } from "./data"

/*
  Demo-only authentication. Passwords are checked for length only and are never
  stored or compared with anything. Registered accounts live in memory for this tab.
*/

export const demoPersonas: Record<DemoRole, {
  identifier: string
  session: Session
}> = {
  citizen: {
    identifier: "citizen@demo.bd",
    session: {
      role: "citizen",
      displayName: sampleApplicant.name,
      accountId: sampleApplicant.accountId,
      demo: true,
    },
  },
  reviewer: {
    identifier: "reviewer@demo.bd",
    session: {
      role: "reviewer",
      displayName: sampleReviewer.name,
      accountId: sampleReviewer.accountId,
      demo: true,
    },
  },
}

/** Name and email only; no password is kept. */
const registered = new Map<string, Session>()
let accountCounter = 1

export class AuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "AuthError"
  }
}

export async function mockLogin({
  email,
  password,
}: LoginInput): Promise<Session> {
  await delay(500)
  if (getMockScenario() === "error")
    throw new Error("Sample error: login service unavailable")
  void password
  const id = email.trim().toLowerCase()
  const persona = Object.values(demoPersonas).find((p) => p.identifier === id)
  if (persona) return persona.session
  const account = registered.get(id)
  if (account) return account
  throw new AuthError("unknown-account")
}

export async function mockRegister(input: RegisterInput): Promise<Session> {
  await delay(600)
  if (getMockScenario() === "error")
    throw new Error("Sample error: registration unavailable")
  const email = input.email.trim().toLowerCase()
  if (
    registered.has(email) ||
    Object.values(demoPersonas).some((p) => p.identifier === email)
  )
    throw new AuthError("email-taken")
  accountCounter += 1
  const session: Session = {
    role: "citizen",
    displayName: input.displayName.trim(),
    accountId: `DEMO-NAG-${String(accountCounter).padStart(4, "0")}`,
    demo: true,
  }
  registered.set(email, session)
  return session
}

export async function mockRequestPasswordReset(
  identifier: string,
): Promise<void> {
  await delay(500)
  void identifier
}
