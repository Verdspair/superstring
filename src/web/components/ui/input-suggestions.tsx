"use client";

import { useCommandState } from "cmdk";
import type * as React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Command, CommandItem, CommandList } from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";

export type InputSuggestion = {
  value: string;
  label?: string;
  description?: string;
  disabled?: boolean;
};

export type InputSuggestionsProps = Omit<
  React.ComponentProps<"input">,
  "onChange" | "value" | "defaultValue" | "list"
> & {
  suggestions: InputSuggestion[];
  value: string;
  onValueChange: (value: string) => void;
};

function matches(suggestion: InputSuggestion, query: string) {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [suggestion.value, suggestion.label, suggestion.description].some((text) =>
    text?.toLowerCase().includes(needle),
  );
}

function Field({
  suggestions,
  value,
  onValueChange,
  className,
  disabled,
  onFocus,
  onClick,
  onKeyDown,
  ...props
}: InputSuggestionsProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const activeValue = useCommandState((state) => state.value);
  const listRef = useRef<HTMLDivElement>(null);
  const filtered = useMemo(
    () => suggestions.filter((suggestion) => matches(suggestion, query)),
    [suggestions, query],
  );

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  useEffect(() => {
    const input = inputRef.current;
    const list = listRef.current;
    if (!input) return;
    const activeSuggestion = filtered.find((suggestion) => suggestion.value === activeValue);
    const option =
      open && list && activeSuggestion
        ? Array.from(list.querySelectorAll<HTMLElement>("[cmdk-item]")).find(
            (item) => item.dataset.value === activeValue,
          )
        : undefined;
    if (option) input.setAttribute("aria-activedescendant", option.id);
    else input.removeAttribute("aria-activedescendant");
    if (open && list) input.setAttribute("aria-controls", list.id);
    else input.removeAttribute("aria-controls");
  }, [open, activeValue, filtered]);

  useEffect(() => {
    if (!open) return;
    const positions = new Map<Element, readonly [number, number]>();
    for (let parent = inputRef.current?.parentElement; parent; parent = parent.parentElement) {
      positions.set(parent, [parent.scrollLeft, parent.scrollTop]);
    }
    const closeOnContainerScroll = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const previous = positions.get(target);
      if (previous && (target.scrollLeft !== previous[0] || target.scrollTop !== previous[1])) {
        setOpen(false);
      }
    };
    document.addEventListener("scroll", closeOnContainerScroll, true);
    return () => document.removeEventListener("scroll", closeOnContainerScroll, true);
  }, [open]);

  const openList = () => {
    if (disabled) return;
    setQuery("");
    setOpen(true);
  };

  const choose = (next: string) => {
    onValueChange(next);
    setQuery("");
    setOpen(false);
    inputRef.current?.focus();
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
    >
      <PopoverAnchor asChild>
        <Input
          {...props}
          ref={inputRef}
          role="combobox"
          aria-expanded={open}
          aria-autocomplete="list"
          disabled={disabled}
          className={className}
          value={value}
          onChange={(event) => {
            const next = event.target.value;
            setQuery(next);
            setOpen(true);
            onValueChange(next);
          }}
          onFocus={(event) => {
            onFocus?.(event);
            if (!open) openList();
          }}
          onClick={(event) => {
            onClick?.(event);
            if (!open) openList();
          }}
          onKeyDown={(event) => {
            onKeyDown?.(event);
            if (event.defaultPrevented) return;
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (!open) {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                openList();
              }
              // Keep cmdk from swallowing editing keys while the list is closed.
              if (
                ["ArrowDown", "ArrowUp", "Home", "End", "Enter"].includes(event.key) ||
                (event.ctrlKey && ["n", "j", "p", "k"].includes(event.key))
              ) {
                event.stopPropagation();
              }
              return;
            }
            if (event.key === "Tab") setOpen(false);
          }}
        />
      </PopoverAnchor>
      <PopoverContent
        align="start"
        sideOffset={4}
        collisionPadding={8}
        sticky="always"
        updatePositionStrategy="always"
        onOpenAutoFocus={(event) => event.preventDefault()}
        onInteractOutside={(event) => {
          if (event.target instanceof Node && inputRef.current?.contains(event.target)) {
            event.preventDefault();
          }
        }}
        className="min-w-64 max-w-[min(420px,calc(100vw-24px))] p-1"
        style={{ width: "var(--radix-popover-trigger-width)" }}
      >
        <CommandList
          ref={listRef}
          aria-labelledby={props["aria-labelledby"]}
          label={typeof props["aria-label"] === "string" ? props["aria-label"] : undefined}
          className="max-h-[min(20rem,var(--radix-popover-content-available-height))] p-0"
        >
          {filtered.length === 0 && (
            <p role="status" className="px-2 py-2 text-xs text-muted-foreground">
              {t("common.freeformSuggestionHint")}
            </p>
          )}
          {filtered.map((suggestion) => (
            <CommandItem
              key={suggestion.value}
              value={suggestion.value}
              title={suggestion.value}
              disabled={suggestion.disabled}
              onSelect={() => choose(suggestion.value)}
              className="gap-2 rounded-md px-2 py-1.5"
            >
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate">{suggestion.label ?? suggestion.value}</span>
                {suggestion.description ? (
                  <span className="truncate text-[11px] text-muted-foreground">
                    {suggestion.description}
                  </span>
                ) : null}
              </span>
            </CommandItem>
          ))}
        </CommandList>
      </PopoverContent>
    </Popover>
  );
}

export function InputSuggestions({ suggestions, ...props }: InputSuggestionsProps) {
  return (
    <Command
      shouldFilter={false}
      vimBindings={false}
      label={typeof props["aria-label"] === "string" ? props["aria-label"] : undefined}
      className="[&>[cmdk-label]]:top-0 [&>[cmdk-label]]:left-0"
      style={{ display: "contents" }}
    >
      <Field suggestions={suggestions} {...props} />
    </Command>
  );
}
