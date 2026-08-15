import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";

/**
 * 自绘下拉：原生 <select> 在 macOS 上会把菜单压在触发器正上方（让选中项对齐按钮），
 * 于是「打开下拉」看起来像「按钮被盖掉了」。这里统一改成 listbox，
 * 菜单永远开在触发器下方（下方空间不够才向上翻），触发器始终可见。
 *
 * 外观取自原来的 .capture-bar select：paper-bright 底 + outline-control + 内嵌 chevron。
 */

export interface SelectOption {
  value: string;
  label: string;
}

interface SelectProps {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  label: string;
  /** 追加在最外层，用于挑尺寸档：select-sm / select-block */
  className?: string;
}

export function Select({ value, options, onChange, label, className = "" }: SelectProps) {
  const [open, setOpen] = useState(false);
  const [dropUp, setDropUp] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLUListElement>(null);
  const listboxId = useId();

  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );
  const selected = options[selectedIndex];

  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    if (refocus) rootRef.current?.querySelector("button")?.focus();
  }, []);

  // 打开时先量一次可用空间：贴着视口底部的行（收藏库表格里很常见）向上翻
  useLayoutEffect(() => {
    if (!open) return;
    const trigger = rootRef.current?.getBoundingClientRect();
    if (!trigger) return;
    const needed = Math.min(options.length, 6) * 34 + 16;
    setDropUp(trigger.bottom + needed > window.innerHeight && trigger.top > needed);
    setActiveIndex(selectedIndex);
  }, [open, options.length, selectedIndex]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [open, activeIndex]);

  const commit = (index: number) => {
    const option = options[index];
    if (option) onChange(option.value);
    close(true);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      if (open) {
        event.stopPropagation();
        close(true);
      }
      return;
    }
    if (!open) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        setOpen(true);
      }
      return;
    }
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setActiveIndex((index) => Math.min(index + 1, options.length - 1));
        break;
      case "ArrowUp":
        event.preventDefault();
        setActiveIndex((index) => Math.max(index - 1, 0));
        break;
      case "Home":
        event.preventDefault();
        setActiveIndex(0);
        break;
      case "End":
        event.preventDefault();
        setActiveIndex(options.length - 1);
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        commit(activeIndex);
        break;
      case "Tab":
        setOpen(false);
        break;
    }
  };

  return (
    <div ref={rootRef} className={`select ${className}`} onKeyDown={onKeyDown}>
      <button
        type="button"
        className="select-trigger"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        /*
         * 开合挂在 pointerdown 而不是 click：<button> 上按 Enter 会先走 keydown
         * （我们在那儿提交并关闭），再补一个 click，click 又会把菜单重新打开。
         * 指针路径和键盘路径分开，就没有这个来回。
         */
        onPointerDown={() => setOpen((wasOpen) => !wasOpen)}
      >
        <span className="select-value">{selected?.label ?? ""}</span>
        <svg className="select-chevron" viewBox="0 0 12 12" aria-hidden="true">
          <path d="m2.5 4.5 3.5 3.5 3.5-3.5" />
        </svg>
      </button>
      {open && (
        <ul
          ref={menuRef}
          id={listboxId}
          className="select-menu"
          role="listbox"
          aria-label={label}
          data-drop={dropUp ? "up" : "down"}
        >
          {options.map((option, index) => (
            <li
              key={option.value}
              role="option"
              aria-selected={option.value === value}
              data-active={index === activeIndex}
              className="select-option"
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => commit(index)}
            >
              {option.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
