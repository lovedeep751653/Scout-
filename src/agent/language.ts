export type Lang = 'en' | 'hi' | 'hinglish';

// Common Hindi words written in English letters. Two hits (or one in a very short
// message) mark the message as Hinglish.
const HINGLISH = new Set(
  (
    'hai hain h kya kyaa kya? mera meri mere mujhe mujhko kitne kitna kitni kaun kaunsa kaunse kaise kab kahan kidhar nahi nahin nhi haan ha ' +
    'ka ki ke ko se par pe aur bhi sab kar karo karna karein batao bataiye bata dikhao dikhaiye chahiye wala wali wale abhi kuch koi aap tum hum ' +
    'apna apne raha rahi rahe tha thi the hoga hogi kiya kiye diya liya mein main yeh ye woh wo kyun kyon jab tab agar lekin ya phir dobara ' +
    'purana purane naya naye kitni baar saare sare bahut thoda sirf'
  ).split(' '),
);

export function detectLanguage(text: string): Lang {
  const letters = text.match(/\p{L}/gu)?.length ?? 0;
  const deva = text.match(/[ऀ-ॿ]/g)?.length ?? 0;
  if (letters > 0 && deva / letters > 0.3) return 'hi';
  const words = text.toLowerCase().match(/[a-z]+/g) ?? [];
  const hits = words.filter((w) => HINGLISH.has(w)).length;
  if (hits >= 2 || (words.length > 0 && words.length <= 4 && hits >= 1)) return 'hinglish';
  return 'en';
}

// A direct instruction works much better than "reply in the user's language" for
// small local models (measured: Hindi questions got English answers without it).
export const LANGUAGE_HINT: Record<Lang, string> = {
  en: 'LANGUAGE: Reply in English.',
  hi: 'LANGUAGE: The user wrote in Hindi. Write your whole reply in Hindi using Devanagari script. Keep email addresses, dates, numbers and service names unchanged.',
  hinglish: 'LANGUAGE: The user wrote in Hinglish (Hindi written in English letters). Reply in simple, natural Hinglish. Keep email addresses, dates, numbers and service names unchanged.',
};

type Msg =
  | 'busy'
  | 'queue_full'
  | 'not_ready'
  | 'downloading'
  | 'ai_down'
  | 'timeout'
  | 'max_steps'
  | 'refusal'
  | 'secrets_removed'
  | 'error'
  | 'setup_problem'
  | 'daily_limit'
  | 'monthly_limit'
  | 'key_budget'
  | 'action_done'
  | 'action_cancelled';

const MESSAGES: Record<Msg, Record<Lang, string>> = {
  busy: {
    en: 'Scout is busy answering other questions right now. Please try again in a minute.',
    hi: 'Scout अभी दूसरे सवालों का जवाब दे रहा है। कृपया एक मिनट बाद फिर कोशिश करें।',
    hinglish: 'Scout abhi dusre sawalon ka jawab de raha hai. Please ek minute baad try karein.',
  },
  queue_full: {
    en: 'Too many people are asking Scout at the same time. Please try again in a minute.',
    hi: 'अभी बहुत से लोग एक साथ Scout से पूछ रहे हैं। कृपया एक मिनट बाद फिर कोशिश करें।',
    hinglish: 'Abhi bahut log ek saath Scout se pooch rahe hain. Please ek minute baad try karein.',
  },
  not_ready: {
    en: 'Scout is still starting up. Please try again in a few minutes.',
    hi: 'Scout अभी शुरू हो रहा है। कृपया कुछ मिनट बाद फिर कोशिश करें।',
    hinglish: 'Scout abhi start ho raha hai. Please kuch minute baad try karein.',
  },
  downloading: {
    en: 'Scout is getting ready (downloading its AI model, {percent}% done). Please try again in a few minutes.',
    hi: 'Scout तैयार हो रहा है (AI मॉडल डाउनलोड हो रहा है, {percent}% पूरा)। कृपया कुछ मिनट बाद फिर कोशिश करें।',
    hinglish: 'Scout ready ho raha hai (AI model download ho raha hai, {percent}% done). Please kuch minute baad try karein.',
  },
  ai_down: {
    en: "Scout's AI engine is not answering right now. Please try again in a moment.",
    hi: 'Scout का AI इंजन अभी जवाब नहीं दे रहा है। कृपया थोड़ी देर बाद फिर कोशिश करें।',
    hinglish: 'Scout ka AI engine abhi jawab nahi de raha. Please thodi der baad try karein.',
  },
  timeout: {
    en: 'That took too long, so I stopped. Please try again, maybe with a shorter question.',
    hi: 'इसमें बहुत समय लगा, इसलिए मैंने रोक दिया। कृपया फिर से पूछें, हो सके तो छोटा सवाल।',
    hinglish: 'Isme bahut time laga, isliye maine rok diya. Please dobara poochein, chhota sawal ho to better.',
  },
  max_steps: {
    en: 'I needed more steps than I am allowed for one question. Please ask about one thing at a time.',
    hi: 'इस सवाल के लिए मुझे तय सीमा से ज़्यादा कदम चाहिए थे। कृपया एक बार में एक चीज़ पूछें।',
    hinglish: 'Is sawal ke liye mujhe limit se zyada steps chahiye the. Please ek baar mein ek cheez poochein.',
  },
  refusal: {
    en: "Sorry, I can't help with that request.",
    hi: 'माफ़ कीजिए, मैं इस अनुरोध में मदद नहीं कर सकता।',
    hinglish: 'Sorry, main is request mein help nahi kar sakta.',
  },
  secrets_removed: {
    en: 'For your safety I removed what looked like a password or code from your message. Never share passwords or OTPs with anyone, including me.',
    hi: 'आपकी सुरक्षा के लिए मैंने आपके संदेश से पासवर्ड या कोड जैसा दिखने वाला हिस्सा हटा दिया। पासवर्ड या OTP किसी के साथ साझा न करें, मेरे साथ भी नहीं।',
    hinglish: 'Aapki safety ke liye maine message se password ya code jaisa hissa hata diya. Password ya OTP kisi ko mat bataiye, mujhe bhi nahi.',
  },
  error: {
    en: 'Something went wrong on my side. Please try again.',
    hi: 'मेरी तरफ़ से कुछ गड़बड़ हो गई। कृपया फिर कोशिश करें।',
    hinglish: 'Meri taraf se kuch gadbad ho gayi. Please dobara try karein.',
  },
  setup_problem: {
    en: 'Scout is not set up correctly yet. The app owner has been shown how to fix it.',
    hi: 'Scout अभी ठीक से सेट नहीं है। ऐप के मालिक को इसे ठीक करने का तरीका दिखाया गया है।',
    hinglish: 'Scout abhi theek se set nahi hai. App owner ko fix karne ka tareeka dikhaya gaya hai.',
  },
  daily_limit: {
    en: 'You have reached today\'s question limit. Please come back tomorrow.',
    hi: 'आपने आज के सवालों की सीमा पूरी कर ली है। कृपया कल फिर आएँ।',
    hinglish: 'Aapne aaj ke sawalon ki limit poori kar li hai. Please kal phir aayiye.',
  },
  monthly_limit: {
    en: 'You have reached this month\'s usage limit. It resets on the 1st of next month.',
    hi: 'आपने इस महीने की सीमा पूरी कर ली है। यह अगले महीने की 1 तारीख को फिर शुरू होगी।',
    hinglish: 'Aapne is mahine ki limit poori kar li hai. Yeh agle mahine ki 1 tareekh ko reset hogi.',
  },
  key_budget: {
    en: 'This app has used its monthly AI budget, so I have to stop here. The owner can raise the budget.',
    hi: 'इस ऐप का इस महीने का AI बजट खत्म हो गया है, इसलिए मुझे यहीं रुकना होगा।',
    hinglish: 'Is app ka is mahine ka AI budget khatam ho gaya hai, isliye mujhe yahin rukna hoga.',
  },
  action_done: {
    en: 'Done: {summary}',
    hi: 'हो गया: {summary}',
    hinglish: 'Ho gaya: {summary}',
  },
  action_cancelled: {
    en: 'Okay, I did not do it: {summary}',
    hi: 'ठीक है, मैंने यह नहीं किया: {summary}',
    hinglish: 'Theek hai, maine yeh nahi kiya: {summary}',
  },
};

export function t(key: Msg, lang: Lang, vars: Record<string, string | number> = {}): string {
  return MESSAGES[key][lang].replace(/\{(\w+)\}/g, (_m, k: string) => String(vars[k] ?? ''));
}

export function isLang(v: unknown): v is Lang {
  return v === 'en' || v === 'hi' || v === 'hinglish';
}
