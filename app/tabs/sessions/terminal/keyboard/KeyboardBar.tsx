import React, { useState, useEffect, useRef } from "react";
import {
  View,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  Text,
  TextInput,
} from "react-native";
import * as Clipboard from "expo-clipboard";
import { Send, X } from "lucide-react-native";
import { TerminalHandle } from "../Terminal";
import KeyboardKey from "./KeyboardKey";
import { useKeyboardCustomization } from "@/app/contexts/KeyboardCustomizationContext";
import { KeyConfig } from "@/types/keyboard";
import { useOrientation } from "@/app/utils/orientation";
import {
  BACKGROUNDS,
  BORDER_COLORS,
  ACCENT,
} from "@/app/constants/designTokens";
import { isRepeatingKey } from "@/constants/keyboard-repeat-config";

interface KeyboardBarProps {
  terminalRef: React.RefObject<TerminalHandle | null>;
  isVisible: boolean;
  onModifierChange?: (modifiers: {
    ctrl: boolean;
    alt: boolean;
    shift: boolean;
  }) => void;
  isKeyboardIntentionallyHidden?: boolean;
  bottomInset?: number;
  onOpenSnippets?: () => void;
  /** Report the draft-box open state so the parent can size the bar
   *  (raise it) and stop the hidden terminal input from stealing focus. */
  onDraftBoxChange?: (open: boolean) => void;
  /** Called when the draft-text box closes so the hidden terminal input can
   *  take focus back (direct typing resumes). */
  onDirectInputFocus?: () => void;
  /** Extra lift (px) for the draft box so it clears whatever sits directly
   *  above the key row (the session tab bar) instead of being covered by it. */
  draftBoxLift?: number;
}

export default function KeyboardBar({
  terminalRef,
  isVisible,
  onModifierChange,
  isKeyboardIntentionallyHidden = false,
  bottomInset = 0,
  onOpenSnippets,
  onDraftBoxChange,
  onDirectInputFocus,
  draftBoxLift = 0,
}: KeyboardBarProps) {
  const { config } = useKeyboardCustomization();
  const { isLandscape } = useOrientation();
  const [ctrlPressed, setCtrlPressed] = useState(false);
  const [altPressed, setAltPressed] = useState(false);
  const [shiftPressed, setShiftPressed] = useState(false);

  // Draft-text box: a plain RN TextInput with the system keyboard, so any
  // language (Vietnamese, Chinese, …) composes normally. The text is only
  // inserted into the terminal at the cursor position when the user sends
  // it. While the box is open, direct terminal typing is paused; when it
  // closes, the hidden terminal input takes focus back.
  const [draftOpen, setDraftOpen] = useState(false);
  const [draftText, setDraftText] = useState("");
  const draftInputRef = useRef<TextInput>(null);

  const sendDraft = () => {
    const text = draftText;
    if (!text) return;
    terminalRef.current?.sendInput(text);
    setDraftText("");
    // Keep the box open + focused so the user can insert more text without
    // reopening it.
    setTimeout(() => draftInputRef.current?.focus(), 0);
  };

  const closeDraftBox = () => {
    setDraftOpen(false);
    setDraftText("");
    onDraftBoxChange?.(false);
    onDirectInputFocus?.();
  };

  const toggleDraftBox = () => {
    if (draftOpen) {
      closeDraftBox();
    } else {
      setDraftOpen(true);
      onDraftBoxChange?.(true);
      setTimeout(() => draftInputRef.current?.focus(), 0);
    }
  };

  const sendKey = (key: string) => {
    terminalRef.current?.sendInput(key);
  };

  const sendSpecialKey = (keyConfig: KeyConfig) => {
    const { value, id } = keyConfig;

    switch (id) {
      case "escape":
        sendKey("\x1b");
        break;
      case "tab":
      case "complete":
      case "comp":
        sendKey(shiftPressed ? "\x1b[Z" : "\t");
        break;
      case "shiftTab":
        sendKey("\x1b[Z");
        break;
      case "arrowUp":
      case "history":
      case "hist":
        sendKey("\x1b[A");
        break;
      case "arrowDown":
        sendKey("\x1b[B");
        break;
      case "arrowRight":
        sendKey("\x1b[C");
        break;
      case "arrowLeft":
        sendKey("\x1b[D");
        break;
      case "paste":
        handlePaste();
        break;
      default:
        sendKey(value);
    }
  };

  const handlePaste = async () => {
    try {
      const clipboardContent = await Clipboard.getStringAsync();
      if (clipboardContent) {
        sendKey(clipboardContent);
      }
    } catch {}
  };

  const toggleModifier = (modifier: "ctrl" | "alt" | "shift") => {
    switch (modifier) {
      case "ctrl":
        setCtrlPressed(!ctrlPressed);
        break;
      case "alt":
        setAltPressed(!altPressed);
        break;
      case "shift":
        setShiftPressed(!shiftPressed);
        break;
    }
  };

  useEffect(() => {
    if (onModifierChange) {
      onModifierChange({
        ctrl: ctrlPressed,
        alt: altPressed,
        shift: shiftPressed,
      });
    }
  }, [ctrlPressed, altPressed, shiftPressed, onModifierChange]);

  if (!isVisible) return null;

  const renderKey = (keyConfig: KeyConfig, index: number) => {
    const isModifier =
      keyConfig.isModifier ||
      keyConfig.id === "ctrl" ||
      keyConfig.id === "alt" ||
      keyConfig.id === "shift";
    const isCtrl = keyConfig.id === "ctrl";
    const isAlt = keyConfig.id === "alt";
    const isShift = keyConfig.id === "shift";

    return (
      <KeyboardKey
        key={`${keyConfig.id}-${index}`}
        label={keyConfig.label}
        onPress={() => {
          if (isModifier) {
            if (isCtrl) toggleModifier("ctrl");
            else if (isAlt) toggleModifier("alt");
            else if (isShift) toggleModifier("shift");
          } else {
            sendSpecialKey(keyConfig);
          }
        }}
        isModifier={isModifier}
        isActive={
          isCtrl
            ? ctrlPressed
            : isAlt
              ? altPressed
              : isShift
                ? shiftPressed
                : false
        }
        keySize={config.settings.keySize}
        hapticFeedback={config.settings.hapticFeedback}
        keyRepeatEnabled={isRepeatingKey(keyConfig.id)}
        keyRepeatInterval={config.settings.keyRepeatInterval}
        keyRepeatInitialDelay={config.settings.keyRepeatInitialDelay}
      />
    );
  };

  const { pinnedKeys, keys } = config.topBar;
  const hasPinnedKeys = pinnedKeys.length > 0;
  const hasPasteKey = [...pinnedKeys, ...keys].some(
    (key) => key.id === "paste",
  );

  // The paper-plane draft toggle sits right after the ESC key (the usual
  // escape hatch), or at the start of the row when ESC is not configured.
  const draftToggleButton = (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel={
        draftOpen ? "Close text insert box" : "Insert text at terminal cursor"
      }
      onPress={toggleDraftBox}
      style={{
        height: 32,
        paddingHorizontal: 10,
        alignItems: "center",
        justifyContent: "center",
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: draftOpen ? ACCENT : BORDER_COLORS.PRIMARY,
        backgroundColor: draftOpen ? ACCENT : BACKGROUNDS.CARD,
      }}
    >
      <Send
        size={15}
        color={draftOpen ? BACKGROUNDS.DARKEST : ACCENT}
      />
    </TouchableOpacity>
  );

  const renderRow = (list: KeyConfig[], prefix: string) =>
    list.map((key, index) => {
      const isEscape = key.id === "escape";
      return (
        <React.Fragment key={`${prefix}-${key.id}-${index}`}>
          {isEscape && draftToggleButton}
          {renderKey(key, index)}
        </React.Fragment>
      );
    });

  return (
    <View
      style={{
        backgroundColor: BACKGROUNDS.DARKEST,
        paddingBottom: isKeyboardIntentionallyHidden ? bottomInset : 0,
        marginTop: 2,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: BORDER_COLORS.PRIMARY,
      }}
    >
      {draftOpen && (
        <View
          style={{
            // Float above the key row AND above the session tab bar that
            // sits directly on top of the key row — without the extra lift
            // the box renders exactly under the tab bar and is completely
            // covered (tab bar zIndex 1004 > bar container 1003).
            position: "absolute",
            left: 0,
            right: 0,
            top: -46 - draftBoxLift,
            height: 44,
            flexDirection: "row",
            alignItems: "center",
            gap: 6,
            paddingHorizontal: 8,
            backgroundColor: BACKGROUNDS.DARKEST,
            borderTopWidth: StyleSheet.hairlineWidth,
            borderTopColor: BORDER_COLORS.PRIMARY,
            borderBottomWidth: StyleSheet.hairlineWidth,
            borderBottomColor: BORDER_COLORS.PRIMARY,
          }}
        >
          <TextInput
            ref={draftInputRef}
            value={draftText}
            onChangeText={setDraftText}
            placeholder="Nhập text (tiếng Việt, 中文, …) — insert vào con trỏ"
            placeholderTextColor="#8a8f98"
            returnKeyType="send"
            onSubmitEditing={sendDraft}
            autoCorrect={false}
            autoComplete="off"
            style={{
              flex: 1,
              height: 38,
              paddingHorizontal: 10,
              backgroundColor: BACKGROUNDS.CARD,
              borderColor: BORDER_COLORS.PRIMARY,
              borderWidth: StyleSheet.hairlineWidth,
              color: "#e8eaed",
              fontSize: 15,
            }}
          />
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel="Insert text into terminal"
            onPress={sendDraft}
            style={{
              height: 38,
              paddingHorizontal: 12,
              alignItems: "center",
              justifyContent: "center",
              borderWidth: StyleSheet.hairlineWidth,
              borderColor: ACCENT,
              backgroundColor: ACCENT,
            }}
          >
            <Send size={16} color={BACKGROUNDS.DARKEST} />
          </TouchableOpacity>
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel="Close text insert box"
            onPress={closeDraftBox}
            style={{
              height: 38,
              paddingHorizontal: 10,
              alignItems: "center",
              justifyContent: "center",
              borderWidth: StyleSheet.hairlineWidth,
              borderColor: BORDER_COLORS.PRIMARY,
              backgroundColor: BACKGROUNDS.CARD,
            }}
          >
            <X size={16} color="#9aa0a8" />
          </TouchableOpacity>
        </View>
      )}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{
          paddingHorizontal: 8,
          paddingVertical: isLandscape ? 6 : 8,
          alignItems: "center",
          gap: isLandscape ? 4 : 6,
        }}
        keyboardShouldPersistTaps="handled"
      >
        {hasPinnedKeys && (
          <>
            {renderRow(pinnedKeys, "pin")}
            <View
              className="mx-2 h-[30px] w-px"
              style={{ backgroundColor: BORDER_COLORS.PRIMARY }}
            />
          </>
        )}

        {renderRow(keys, "top")}

        {!hasPasteKey && (
          <>
            <View
              style={{
                width: StyleSheet.hairlineWidth,
                height: 30,
                backgroundColor: BORDER_COLORS.PRIMARY,
                marginHorizontal: 8,
              }}
            />
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel="Paste clipboard into terminal"
              onPress={handlePaste}
              style={{
                height: 32,
                paddingHorizontal: 10,
                alignItems: "center",
                justifyContent: "center",
                borderWidth: StyleSheet.hairlineWidth,
                borderColor: BORDER_COLORS.PRIMARY,
                backgroundColor: BACKGROUNDS.CARD,
              }}
            >
              <Text
                style={{
                  fontSize: 10,
                  fontWeight: "700",
                  color: ACCENT,
                  letterSpacing: 0.5,
                }}
              >
                PASTE
              </Text>
            </TouchableOpacity>
          </>
        )}

        {onOpenSnippets && (
          <>
            <View
              style={{
                width: StyleSheet.hairlineWidth,
                height: 30,
                backgroundColor: BORDER_COLORS.PRIMARY,
                marginHorizontal: 8,
              }}
            />
            <TouchableOpacity
              onPress={onOpenSnippets}
              style={{
                height: 32,
                paddingHorizontal: 10,
                alignItems: "center",
                justifyContent: "center",
                borderWidth: StyleSheet.hairlineWidth,
                borderColor: BORDER_COLORS.PRIMARY,
                backgroundColor: BACKGROUNDS.CARD,
              }}
            >
              <Text
                style={{
                  fontSize: 11,
                  fontWeight: "600",
                  color: ACCENT,
                  letterSpacing: 0.5,
                }}
              >
                {"{ }"}
              </Text>
            </TouchableOpacity>
          </>
        )}
      </ScrollView>
    </View>
  );
}
