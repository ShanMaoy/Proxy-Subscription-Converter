import { useMutation } from "@tanstack/react-query";
import type {
  RuleAssistantResponse,
  RuleCoverage,
  UserRule,
} from "@subscription-converter/shared";
import { ArrowUp, Bot, X } from "lucide-react";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { apiRequest } from "../lib/api";
import { ErrorBanner } from "./ErrorBanner";

type AssistantTurn = {
  id: number;
  question: string;
  snapshot: string;
  reply: RuleAssistantResponse;
  applied: boolean;
};

export function RuleAssistant({
  rules,
  policies,
  ruleProviders,
  scope,
  busy,
  onApply,
}: {
  rules: UserRule[];
  policies: string[];
  ruleProviders: string[];
  scope: string;
  busy: boolean;
  onApply: (rules: UserRule[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [turns, setTurns] = useState<AssistantTurn[]>([]);
  const launcher = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const thread = useRef<HTMLDivElement>(null);
  const nextTurn = useRef(0);
  const id = useId();

  useEffect(() => {
    if (open) closeButton.current?.focus();
  }, [open]);

  const request = useMutation({
    mutationFn: ({
      question,
      snapshot,
    }: {
      question: string;
      snapshot: string;
    }) =>
      apiRequest<RuleAssistantResponse>("/api/rules/assistant", {
        method: "POST",
        body: JSON.stringify({
          rules: JSON.parse(snapshot) as UserRule[],
          prompt: question,
          policies,
          ruleProviders,
          scope,
          history: turns.slice(-4).map((turn) => ({
            question: turn.question,
            answer: turn.reply.answer,
          })),
        }),
      }),
    onSuccess: (reply, { question, snapshot }) => {
      const turn = {
        id: nextTurn.current++,
        question,
        snapshot,
        reply,
        applied: false,
      };
      setTurns((current) => [...current, turn]);
    },
    onError: (_error, { question }) =>
      setPrompt((current) => current || question),
  });

  useEffect(() => {
    if (open && thread.current)
      thread.current.scrollTop = thread.current.scrollHeight;
  }, [open, request.isPending, turns.length]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const question = prompt.trim();
    if (!question || request.isPending || busy) return;
    request.mutate({ question, snapshot: JSON.stringify(rules) });
    setPrompt("");
  };

  const close = () => {
    setOpen(false);
    launcher.current?.focus();
  };
  const currentSnapshot =
    open && turns.some((turn) => turn.reply.proposal && !turn.applied)
      ? JSON.stringify(rules)
      : "";

  return (
    <div className="rule-assistant">
      <button
        type="button"
        ref={launcher}
        className="icon-action assistant-launcher"
        aria-label={open ? "隐藏规则 AI 助手" : "打开规则 AI 助手"}
        aria-controls={open ? id : undefined}
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <Bot size={24} />
      </button>
      {open && (
        <section
          id={id}
          className="assistant-window"
          aria-labelledby={id + "-title"}
          onKeyDown={(event) => {
            if (event.key === "Escape") close();
          }}
        >
          <header className="assistant-heading">
            <h2 id={id + "-title"}>规则 AI 助手</h2>
            <button
              type="button"
              ref={closeButton}
              className="icon-action"
              aria-label="关闭规则 AI 助手"
              onClick={close}
            >
              <X size={18} />
            </button>
          </header>
          <div
            className="assistant-thread"
            ref={thread}
            role="log"
            aria-live="polite"
          >
            {turns.length === 0 && !request.isPending && (
              <p className="assistant-intro">
                说说你访问哪个网站、遇到了什么。我可以按当前规则核对可能走的策略。
                <small>配置模型后，对话和当前规则会发送给所选 AI 服务。</small>
              </p>
            )}
            {turns.map((turn) => (
              <div key={turn.id} className="assistant-turn">
                <p className="assistant-message assistant-message-user">
                  {turn.question}
                </p>
                <div className="assistant-message assistant-message-reply">
                  <p className="assistant-answer">{turn.reply.answer}</p>
                  {turn.reply.coverage && (
                    <CoverageResult coverage={turn.reply.coverage} />
                  )}
                  {turn.reply.proposal && (
                    <Proposal
                      turn={turn}
                      stale={turn.snapshot !== currentSnapshot}
                      busy={busy || request.isPending}
                      onApply={() => {
                        if (
                          !turn.reply.proposal ||
                          turn.applied ||
                          turn.snapshot !== currentSnapshot ||
                          busy ||
                          request.isPending
                        )
                          return;
                        onApply(turn.reply.proposal);
                        setTurns((current) =>
                          current.map((item) =>
                            item.id === turn.id
                              ? { ...item, applied: true }
                              : item,
                          ),
                        );
                      }}
                    />
                  )}
                </div>
              </div>
            ))}
            {request.isPending && (
              <>
                <p className="assistant-message assistant-message-user">
                  {request.variables.question}
                </p>
                <p
                  className="assistant-message assistant-message-reply"
                  role="status"
                >
                  正在核对规则…
                </p>
              </>
            )}
            <ErrorBanner error={request.error} />
          </div>
          <form className="assistant-form" onSubmit={submit}>
            <label className="sr-only" htmlFor={id + "-message"}>
              输入消息
            </label>
            <textarea
              id={id + "-message"}
              rows={1}
              value={prompt}
              maxLength={4000}
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={(event) => {
                if (
                  event.key === "Enter" &&
                  !event.shiftKey &&
                  !event.nativeEvent.isComposing
                ) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
              placeholder="问问分流规则…"
            />
            <button
              type="submit"
              className="assistant-send"
              aria-label="发送"
              disabled={request.isPending || busy || !prompt.trim()}
            >
              <ArrowUp size={19} strokeWidth={2.4} aria-hidden="true" />
            </button>
          </form>
        </section>
      )}
    </div>
  );
}

function Proposal({
  turn,
  stale,
  busy,
  onApply,
}: {
  turn: AssistantTurn;
  stale: boolean;
  busy: boolean;
  onApply: () => void;
}) {
  return (
    <div className="assistant-proposal">
      <h3>待确认的更改</h3>
      <ol>
        {turn.reply.changes.map((change, index) => (
          <li key={index}>{change}</li>
        ))}
      </ol>
      {turn.applied ? (
        <p role="status">已应用到草稿，保存规则后生效。</p>
      ) : (
        <>
          {stale && (
            <p className="field-help">规则草稿已变动，请重新生成建议。</p>
          )}
          <button
            type="button"
            className="primary-button"
            disabled={stale || busy}
            onClick={onApply}
          >
            同意并应用到草稿
          </button>
          <p className="field-help">保存规则后生效。</p>
        </>
      )}
    </div>
  );
}

function CoverageResult({ coverage }: { coverage: RuleCoverage }) {
  return (
    <div className="assistant-coverage">
      <h3>{coverage.target} · 覆盖核对</h3>
      {coverage.matches.length ? (
        <ul>
          {coverage.matches.map((match) => (
            <li key={match.id}>
              <strong>
                {match.ruleType}，{match.value} → {match.policy}
              </strong>
              <div>{match.reason}</div>
            </li>
          ))}
        </ul>
      ) : (
        <p>在已核对的规则中未发现明确匹配。</p>
      )}
      {coverage.unchecked.length > 0 && (
        <details>
          <summary>查看核对限制</summary>
          <ul>
            {coverage.unchecked.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
