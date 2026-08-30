import { useSyncExternalStore } from 'react';

export type Language = 'zh-CN' | 'en-US';
const STORAGE_KEY = 'jsbsim-language';
const listeners = new Set<() => void>();

function initialLanguage(): Language {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved === 'zh-CN' || saved === 'en-US') return saved;
  return navigator.language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US';
}

let currentLanguage = initialLanguage();

export function setLanguage(language: Language) {
  currentLanguage = language;
  localStorage.setItem(STORAGE_KEY, language);
  document.documentElement.lang = language;
  listeners.forEach(listener => listener());
}

export function useLanguage() {
  const language = useSyncExternalStore(
    callback => { listeners.add(callback); return () => listeners.delete(callback); },
    () => currentLanguage,
  );
  return { language, setLanguage, isZh: language === 'zh-CN' };
}

document.documentElement.lang = currentLanguage;
