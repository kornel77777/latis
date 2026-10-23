import { useState } from "react";
import { ArrowRight, Bot, FolderOpen, Sparkles } from "lucide-react";
import * as RadixDialog from "@radix-ui/react-dialog";
import { Button } from "@latis/ui";
import type { Project } from "@latis/shared";
import { useWorkspace } from "../stores/workspace";
import { AgentList } from "./AgentList";

// First run (§8.10): welcome → agents → first project → chats ready with a starter prompt each.
// The interactive checklist comes with the M4 onboarding pass.

const STARTERS = [
  "Give me a quick tour of this project: what it does, how it's organised, and where to start reading.",
  "Find one small, safe improvement worth making here. Propose it before changing anything.",
];

const steps = ["Welcome", "Agents", "Project"] as const;

export function Onboarding() {
  const open = useWorkspace((s) => s.onboardingOpen);
  const agents = useWorkspace((s) => s.agents);
  const finish = useWorkspace((s) => s.finishOnboarding);
  const [step, setStep] = useState(0);
  const ready = agents.filter((a) => a.id !== "fake" && a.kind === "structured" && a.installed && a.signedIn);

  const startIn = async (project: Project | null) => {
    const st = useWorkspace.getState();
    if (!project || ready.length === 0) {
      await st.createChat({ agentId: "fake", projectId: project?.id ?? null });
    } else {
      // Two chats side by side when two agents are ready, otherwise one.
      for (const [i, a] of ready.slice(0, 2).entries()) {
        await st.createChat({ agentId: a.id, projectId: project.id, draft: STARTERS[i]! });
      }
    }
    setStep(0);
    await finish();
  };

  return (
    <RadixDialog.Root open={open} onOpenChange={(o) => !o && void finish()}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-50 bg-bg-0/80 backdrop-blur-sm" />
        <RadixDialog.Content
          className="fixed left-1/2 top-1/2 z-50 flex max-h-[88vh] w-[min(92vw,560px)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-panel border border-line bg-surface shadow-lift"
          data-testid="onboarding"
        >
          <div className="flex items-center gap-1.5 border-b border-line px-5 py-3 text-[11px] text-text-3">
            {steps.map((label, i) => (
              <span key={label} className={i === step ? "font-semibold text-text-1" : undefined}>
                {i > 0 && <span className="mx-1.5">›</span>}
                {label}
              </span>
            ))}
            <button className="ml-auto text-text-3 hover:text-text-1" onClick={() => void finish()} data-testid="onboarding-skip">
              Skip
            </button>
          </div>
          <div className="min-h-0 overflow-y-auto p-5">
            {step === 0 && (
              <>
                <RadixDialog.Title className="flex items-center gap-2 text-[20px] font-semibold text-text-1">
                  <Sparkles size={18} className="text-accent" /> Welcome to Latis
                </RadixDialog.Title>
                <RadixDialog.Description className="mt-2 text-[14px] leading-relaxed text-text-2">
                  Run your coding agents side by side on one canvas. Each folder becomes a project; each chat is an agent working in it.
                  Approvals and finished work collect in the Inbox, so you can step away and come back.
                </RadixDialog.Description>
                <Button variant="primary" className="mt-5" onClick={() => setStep(1)} data-testid="onboarding-next">
                  Get started <ArrowRight size={14} />
                </Button>
              </>
            )}
            {step === 1 && (
              <>
                <RadixDialog.Title className="text-[17px] font-semibold text-text-1">Your agents</RadixDialog.Title>
                <RadixDialog.Description className="mb-4 mt-1 text-[13px] text-text-2">
                  Latis drives the agent CLIs you already have, signed in with your own accounts. Sign-in opens the agent's own login in a
                  terminal.
                </RadixDialog.Description>
                <AgentList hideDemo compact />
                <div className="mt-5 flex items-center gap-2">
                  <Button variant="primary" disabled={ready.length === 0} onClick={() => setStep(2)} data-testid="onboarding-next">
                    Continue <ArrowRight size={14} />
                  </Button>
                  <Button variant="ghost" onClick={() => void startIn(null)} data-testid="onboarding-demo">
                    <Bot size={14} /> Explore with the demo agent
                  </Button>
                </div>
              </>
            )}
            {step === 2 && (
              <>
                <RadixDialog.Title className="text-[17px] font-semibold text-text-1">Your first project</RadixDialog.Title>
                <RadixDialog.Description className="mb-4 mt-1 text-[13px] text-text-2">
                  Pick a folder to work in.{" "}
                  {ready.length > 1 ? `${ready[0]!.displayName} and ${ready[1]!.displayName}` : ready[0]?.displayName} will start there with
                  a suggested first message you can edit before sending.
                </RadixDialog.Description>
                <div className="flex flex-col gap-2">
                  <Button
                    variant="primary"
                    onClick={() =>
                      void useWorkspace
                        .getState()
                        .openFolder({ x: 0, y: 0 })
                        .then((p) => p && startIn(p))
                    }
                    data-testid="onboarding-folder"
                  >
                    <FolderOpen size={14} /> Open a folder…
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() =>
                      void useWorkspace
                        .getState()
                        .createSandbox()
                        .then((p) => p && startIn(p))
                    }
                    data-testid="onboarding-sandbox"
                  >
                    Create a sandbox project
                  </Button>
                </div>
              </>
            )}
          </div>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
