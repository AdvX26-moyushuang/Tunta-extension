import type { KeyboardEvent, ReactNode } from "react";
import type { CardType } from "@/shared/api/contracts";

/**
 * 知识卡片的统一渲染（计划 §Task5.1）：刷卡 / Library / 搜索 / 实体侧栏
 * 共用一个视觉身份，让用户在任何界面都能认出「这是一张卡」。
 *
 * 三种密度：
 * - full：刷卡页。类型 + 标题 + 正文 + 实体标签，证据条等追加区域由 children 传入
 * - compact：Library 列表、搜索结果。类型 + 标题 + 正文截断 + 来源 + 实体标签
 * - inline：实体侧栏、mention 列表。类型 + 标题 + 一行摘要
 *
 * 只负责渲染，不携带任何交互逻辑（划走/归档/star 由调用方经 children / onOpen 组装）。
 */

export type KnowledgeCardDensity = "full" | "compact" | "inline";

/** 各页面卡片形态（LibraryCard / RetrievedCard）都能零转换收敛到这个最小面。 */
export interface KnowledgeCardData {
  cardId: string;
  cardType: CardType;
  title: string;
  body: string;
  domainLabels: string[];
}

interface KnowledgeCardProps {
  density: KnowledgeCardDensity;
  card: KnowledgeCardData;
  /** 来源说明（host · 时间 / source_id）：full 放 topline 右侧，compact 放页脚 */
  meta?: ReactNode;
  /** compact 右上角徽标（如检索命中信号） */
  badge?: ReactNode;
  /** compact / inline 整卡点击（打开原文或详情） */
  onOpen?: () => void;
  className?: string;
  /** full：标签之后的追加区域（证据条）；compact：页脚操作区 */
  children?: ReactNode;
}

/** CardType 的中文名，与刷卡页现有英文枚举并存展示。 */
export const CARD_TYPE_LABELS: Record<CardType, string> = {
  insight: "洞察",
  quote: "引文",
  method: "方法",
  question: "问题",
  action: "行动",
};

function clickableProps(onOpen?: () => void) {
  if (!onOpen) return {};
  return {
    role: "button" as const,
    tabIndex: 0,
    onClick: onOpen,
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      // 内嵌按钮（star / 打开原文）自己处理键盘，不冒泡成整卡打开
      if (event.target !== event.currentTarget) return;
      event.preventDefault();
      onOpen();
    },
  };
}

export function KnowledgeCard({ density, card, meta, badge, onOpen, className, children }: KnowledgeCardProps) {
  if (density === "full") {
    return (
      <article className={`knowledge-card ${className ?? ""}`}>
        <div className="card-topline">
          <span className="card-type">{card.cardType}</span>
          <span>{meta}</span>
        </div>
        <h1 className="card-title">{card.title}</h1>
        <p className="card-body">{card.body}</p>
        <div className="card-domain-list">
          {card.domainLabels.map((label) => (
            <span key={label} className="domain-pill">
              {label}
            </span>
          ))}
        </div>
        {children}
      </article>
    );
  }

  if (density === "inline") {
    return (
      <article
        className={`knowledge-card kc-inline ${onOpen ? "kc-clickable" : ""} ${className ?? ""}`}
        {...clickableProps(onOpen)}
      >
        <span className="card-type">{CARD_TYPE_LABELS[card.cardType] ?? card.cardType}</span>
        <span className="kc-inline-text">
          <strong className="kc-inline-title">{card.title}</strong>
          <span className="kc-inline-summary">{card.body}</span>
        </span>
      </article>
    );
  }

  return (
    <article
      className={`knowledge-card kc-compact ${onOpen ? "kc-clickable" : ""} ${className ?? ""}`}
      {...clickableProps(onOpen)}
    >
      <div className="kc-compact-top">
        <span className="card-type">{CARD_TYPE_LABELS[card.cardType] ?? card.cardType}</span>
        {badge}
      </div>
      <h3 className="kc-compact-title">{card.title}</h3>
      <p className="kc-compact-body">{card.body}</p>
      {(card.domainLabels.length > 0 || meta) && (
        <div className="kc-compact-foot">
          {card.domainLabels.length > 0 && (
            <div className="card-domain-list kc-compact-domains">
              {card.domainLabels.map((label) => (
                <span key={label} className="domain-pill">
                  {label}
                </span>
              ))}
            </div>
          )}
          {meta && <span className="kc-compact-source">{meta}</span>}
        </div>
      )}
      {children}
    </article>
  );
}
