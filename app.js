/* ==========================================================================
   주누디자인 NH농협 실시간 입금 확인 및 최근 7일 직원 공유 보드 (app.js v2)
   - 잔액 / 출금 내역 100% 자동 필터링 (프라이버시 보호)
   - 농협 문자(SMS) / 카톡 알림톡(여러 줄) / 인터넷뱅킹 표 복사 / 엑셀(.xls/.xlsx/.csv) 완벽 파싱
   - PC 시스템 시계 오차 자동 보정 & 등록 내역 숨김 방지
   - GitHub db-store 브랜치 & Google Apps Script 실시간 양방향 동기화
   ========================================================================== */

const STORAGE_KEYS = {
  DEPOSITS: 'nh_deposits_data_v1',
  DELETED_IDS: 'nh_deposits_deleted_ids_v1',
  SETTINGS: 'nh_deposits_settings_v1',
  SOUND_ON: 'nh_deposits_sound_on_v1',
  SHOW_TOTAL: 'nh_deposits_show_total_v1',
  DARK_MODE: 'nh_deposits_dark_mode_v1',
  HIDE_TUTORIAL: 'nh_deposits_hide_tutorial_v1'
};

const QUICK_ITEM_TAGS = ['명함', '스티커', '전단지', '빌지/영수증', '리플렛', '카다로그', '시트지'];

let state = {
  deposits: [],
  deletedIds: new Set(),
  selectedDayOffset: '7days', // '7days', 'all', '0'..'6'
  statusFilter: 'all',        // 'all', 'unconfirmed', 'confirmed'
  soundEnabled: true,
  showTotalAmount: false,
  isSyncing: false,
  lastLocalWriteTs: 0,
  lastSha: null,
  knownIds: new Set(),
  initialLoadDone: false,
  realKstDateStr: null,       // 서버 헤더 기준 실제 한국 날짜 (PC 시계 오차 보정용)
  previewItems: [],           // 모달 실시간 인식 미리보기 배열
  settings: {
    ghOwner: 'joonoodesign',
    ghRepo: 'nh-deposit-monitor',
    ghToken: '',
    gasWebhook: '',
    tgBotToken: '',
    tgChatId: ''
  }
};

// --------------------------------------------------------------------------
// 1. 초기화 및 URL 해시(#ghSync / ?sms) 자동 처리
// --------------------------------------------------------------------------
window.addEventListener('DOMContentLoaded', async () => {
  loadLocalSettings();
  handleUrlAutoConnectAndSms();
  loadLocalDeposits();

  renderDayTabs();
  renderDeposits();
  updateKpiSummary();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js?v=2').catch(() => {});
  }

  const hideTut = localStorage.getItem(STORAGE_KEYS.HIDE_TUTORIAL) === 'true';
  const chkTut = document.getElementById('chkHideTutorialStartup');
  if (chkTut) chkTut.checked = hideTut;

  // 클라우드 최초 동기화 및 6초 주기 실시간 폴링
  await syncFromCloud(true);
  setInterval(() => {
    syncFromCloud(false);
  }, 6000);
});

function loadLocalSettings() {
  try {
    const savedSettings = JSON.parse(localStorage.getItem(STORAGE_KEYS.SETTINGS) || '{}');
    state.settings = { ...state.settings, ...savedSettings };
  } catch (e) {}

  try {
    const savedDeleted = JSON.parse(localStorage.getItem(STORAGE_KEYS.DELETED_IDS) || '[]');
    if (Array.isArray(savedDeleted)) {
      state.deletedIds = new Set(savedDeleted);
    }
  } catch (e) {}

  const soundPref = localStorage.getItem(STORAGE_KEYS.SOUND_ON);
  state.soundEnabled = soundPref === null ? true : soundPref === 'true';
  updateSoundButtonUI();

  state.showTotalAmount = localStorage.getItem(STORAGE_KEYS.SHOW_TOTAL) === 'true';

  if (localStorage.getItem(STORAGE_KEYS.DARK_MODE) === 'true') {
    document.body.classList.add('dark-mode');
  }
}

function loadLocalDeposits() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.DEPOSITS);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        state.deposits = parsed.filter((d) => d && d.id && !state.deletedIds.has(d.id));
        state.deposits.forEach((d) => state.knownIds.add(d.id));
      }
    }
  } catch (e) {
    state.deposits = [];
  }
}

function saveLocalDeposits() {
  state.lastLocalWriteTs = Date.now();
  localStorage.setItem(STORAGE_KEYS.DEPOSITS, JSON.stringify(state.deposits));
  localStorage.setItem(STORAGE_KEYS.DELETED_IDS, JSON.stringify(Array.from(state.deletedIds)));
}

function handleUrlAutoConnectAndSms() {
  const hash = window.location.hash || '';
  const search = window.location.search || '';

  if (hash.includes('ghSync=')) {
    try {
      const match = hash.match(/ghSync=([^&]+)/);
      if (match && match[1]) {
        const rawVal = decodeURIComponent(match[1]);
        let decodedObj = null;
        try {
          decodedObj = JSON.parse(atob(rawVal));
        } catch (_) {
          decodedObj = { ghToken: rawVal };
        }
        if (decodedObj) {
          state.settings = {
            ...state.settings,
            ghOwner: decodedObj.o || decodedObj.ghOwner || state.settings.ghOwner || 'joonoodesign',
            ghRepo: decodedObj.r || decodedObj.ghRepo || state.settings.ghRepo || 'nh-deposit-monitor',
            ghToken: decodedObj.t || decodedObj.ghToken || state.settings.ghToken,
            gasWebhook: decodedObj.g || decodedObj.gasWebhook || state.settings.gasWebhook,
            tgBotToken: decodedObj.tb || decodedObj.tgBotToken || state.settings.tgBotToken,
            tgChatId: decodedObj.tc || decodedObj.tgChatId || state.settings.tgChatId
          };
          localStorage.setItem(STORAGE_KEYS.SETTINGS, JSON.stringify(state.settings));
          showToast('실시간 동기화 연결 완료', '농협 실시간 입금 공유 DB에 자동으로 연결되었습니다.');
        }
      }
    } catch (e) {
      console.error('ghSync parse error:', e);
    }
  }

  const urlParams = new URLSearchParams(search);
  let smsText = urlParams.get('sms') || '';
  if (!smsText && hash.includes('sms=')) {
    const m = hash.match(/sms=([^&]+)/);
    if (m && m[1]) smsText = decodeURIComponent(m[1]);
  }

  if (smsText) {
    setTimeout(async () => {
      const added = ingestRawText(smsText, true);
      if (added > 0) {
        await pushToCloud();
      }
    }, 400);
  }

  if (hash.includes('ghSync=') || hash.includes('sms=') || search.includes('sms=')) {
    const cleanUrl = window.location.pathname;
    window.history.replaceState({}, document.title, cleanUrl);
  }
}

// --------------------------------------------------------------------------
// 2. 기준 날짜 계산 (PC 시계가 잘못되어 있어도 실제 거래일/서버시간 자동 보정)
// --------------------------------------------------------------------------
function getTodayReferenceDateStr() {
  // 1순위: 서버 응답 헤더로 확인된 실제 한국 날짜(KST)
  if (state.realKstDateStr) {
    // 단, 등록된 입금 내역 중 가장 최신 날짜가 있다면 최신 입금일과 비교해 최근 거래일이 탭 기준이 되도록 보장
    if (state.deposits.length > 0) {
      const latestDepositDate = state.deposits.reduce(
        (maxD, item) => (item.date && item.date > maxD ? item.date : maxD),
        ''
      );
      if (latestDepositDate) return latestDepositDate > state.realKstDateStr ? latestDepositDate : state.realKstDateStr;
    }
    return state.realKstDateStr;
  }

  // 2순위: 등록된 입금 내역 중 가장 최신 날짜 (PC 시계가 11월 등으로 어긋나 있을 때 내역이 숨겨지는 현상 완벽 방지)
  if (state.deposits.length > 0) {
    const latestDepositDate = state.deposits.reduce(
      (maxD, item) => (item.date && item.date > maxD ? item.date : maxD),
      ''
    );
    if (latestDepositDate) return latestDepositDate;
  }

  // 3순위: 로컬 시계
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function getDateStringDaysAgo(daysAgo, baseDateStr = null) {
  const refStr = baseDateStr || getTodayReferenceDateStr();
  const parts = refStr.split('-').map((n) => parseInt(n, 10));
  const d = new Date(parts[0], (parts[1] || 1) - 1, parts[2] || 1);
  d.setDate(d.getDate() - daysAgo);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function isWithinLast7Days(dateStr) {
  if (!dateStr) return true;
  const refStr = getTodayReferenceDateStr();
  const minDateStr = getDateStringDaysAgo(6, refStr);
  return dateStr >= minDateStr && dateStr <= refStr;
}

// --------------------------------------------------------------------------
// 3. 초강력 만능 농협 입금 파서 (문자 / 카톡 여러 줄 / 뱅킹 표 복사 / 엑셀 / 간편 입력)
// --------------------------------------------------------------------------
function parseMoneyInt(val) {
  if (typeof val === 'number') return Math.round(val);
  if (!val) return 0;
  const s = String(val).trim();
  // '3만5천원', '5만원' 등 한글 금액 처리
  if (s.includes('만')) {
    const parts = s.replace(/[^0-9만천백십.]/g, '').split('만');
    const man = parseFloat(parts[0] || '0') * 10000;
    let rem = 0;
    if (parts[1]) {
      if (parts[1].includes('천')) {
        rem = parseFloat(parts[1].replace(/[^0-9.]/g, '') || '0') * 1000;
      } else {
        rem = parseFloat(parts[1].replace(/[^0-9.]/g, '') || '0');
      }
    }
    return Math.round(man + rem);
  }
  const digits = s.replace(/[^\d-]/g, '');
  const n = parseInt(digits, 10);
  return isNaN(n) ? 0 : n;
}

function normalizeDateString(rawDateStr, fallbackYear) {
  if (!rawDateStr) return null;
  const s = String(rawDateStr).trim();
  const full = s.match(/(\d{4})[-./년\s]+(\d{1,2})[-./월\s]+(\d{1,2})/);
  if (full) {
    return `${full[1]}-${full[2].padStart(2, '0')}-${full[3].padStart(2, '0')}`;
  }
  const short8 = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (short8) {
    return `${short8[1]}-${short8[2]}-${short8[3]}`;
  }
  const md = s.match(/(\d{1,2})[-./월\s]+(\d{1,2})/);
  if (md) {
    const m = parseInt(md[1], 10);
    const d = parseInt(md[2], 10);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      return `${fallbackYear}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
  }
  return null;
}

function normalizeTimeString(rawTimeStr) {
  if (!rawTimeStr) return null;
  const m = String(rawTimeStr).match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (m) {
    const hh = parseInt(m[1], 10);
    const mm = parseInt(m[2], 10);
    if (hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59) {
      return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
    }
  }
  return null;
}

function parseNHDepositText(rawText) {
  if (!rawText || !String(rawText).trim()) return [];

  const refDateStr = getTodayReferenceDateStr();
  const fallbackYear = refDateStr.slice(0, 4);
  const now = new Date();
  const fallbackTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

  const text = String(rawText).replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return [];

  const results = [];

  // ----------------------------------------------------------------------
  // 패턴 A: 카카오톡 알림톡 / 스마트뱅킹 다중 줄(Key: Value) 형식 감지
  // 예: 입금금액 : 35,000원 \n 입금자명 : 홍길동 \n 입금일시 : 2026/04/14 15:20
  // ----------------------------------------------------------------------
  if (lines.some((l) => /(?:입금금액|거래금액|입금자명|보낸분|입금일시|거래일시)\s*[:：]/.test(l))) {
    let cur = {};
    const flushCur = () => {
      if (cur.amount && cur.amount > 0 && !cur.isWithdrawal) {
        const dStr = cur.date || refDateStr;
        const tStr = cur.time || fallbackTime;
        const sender = cur.sender || '입금자';
        results.push(buildDepositRecord(dStr, tStr, sender, cur.amount, results.length));
      }
      cur = {};
    };

    for (const line of lines) {
      if (/^\[.*알림.*\]|^\[?NH농협|^\[Web발신\]/.test(line) && cur.amount) {
        flushCur();
      }
      if (/출금금액|출금알림|지급/.test(line) && !/입금/.test(line)) {
        cur.isWithdrawal = true;
      }
      const amtKV = line.match(/(?:입금금액|거래금액|입금액|금액)\s*[:：]\s*([\d,]+)\s*원?/);
      if (amtKV) cur.amount = parseMoneyInt(amtKV[1]);

      const senderKV = line.match(/(?:입금자명|입금자|보낸분|성명|기재내용|적요|거래기록사항)\s*[:：]\s*(.+)/);
      if (senderKV) cur.sender = cleanSenderName(senderKV[1]);

      const dtKV = line.match(/(?:입금일시|거래일시|일시|거래일자)\s*[:：]\s*(.+)/);
      if (dtKV) {
        const d = normalizeDateString(dtKV[1], fallbackYear);
        const t = normalizeTimeString(dtKV[1]);
        if (d) cur.date = d;
        if (t) cur.time = t;
      }
    }
    flushCur();
    if (results.length > 0) return results;
  }

  // ----------------------------------------------------------------------
  // 패턴 B: 농협 인터넷뱅킹 / 기업뱅킹 / 빠른조회 표 복사 (탭 \t 또는 다중 공백 구분)
  // ----------------------------------------------------------------------
  const tabLines = lines.filter((l) => l.includes('\t') || /\s{2,}/.test(l));
  if (tabLines.length >= 1 && lines.some((l) => l.includes('\t'))) {
    const rows = lines.map((l) => l.split('\t').map((c) => c.trim()));
    const parsedTable = parseTabularRows(rows, fallbackYear, refDateStr, fallbackTime);
    if (parsedTable.length > 0) return parsedTable;
  }

  // ----------------------------------------------------------------------
  // 패턴 C: 여러 줄로 나뉜 문자/알림 블록을 문맥 단위로 병합하여 파싱
  // ----------------------------------------------------------------------
  let blocks = [];
  if (lines.length > 1) {
    // 각 줄마다 금액과 날짜/이름이 모두 있으면 1줄 = 1건으로 처리
    const linesWithMoney = lines.filter((l) => /\d{1,3}(?:,\d{3})+|\d{4,}/.test(l.replace(/\d{4}[-./]\d{1,2}[-./]\d{1,2}/g, '')));
    if (linesWithMoney.length === lines.length) {
      blocks = lines;
    } else {
      // 여러 줄이 하나의 입금 문자인 경우 병합
      let currentBlock = [];
      for (const line of lines) {
        const isStartHeader = /^\[Web발신\]|^\[?NH농협|^\[?농협|^NH스마트뱅킹|^\[입금/.test(line);
        if (isStartHeader && currentBlock.length > 0) {
          blocks.push(currentBlock.join(' '));
          currentBlock = [line];
        } else {
          currentBlock.push(line);
          // '잔액' 줄이 나오면 한 문자 블록의 끝으로 판단
          if (/잔액\s*[:：]?\s*[\d,]+/.test(line)) {
            blocks.push(currentBlock.join(' '));
            currentBlock = [];
          }
        }
      }
      if (currentBlock.length > 0) {
        // 남은 줄들 중 줄마다 금액이 있으면 개별 처리, 아니면 합침
        const subWithMoney = currentBlock.filter((l) => /\d{1,3}(?:,\d{3})+|\d{4,}/.test(l));
        if (subWithMoney.length > 1) {
          blocks.push(...currentBlock);
        } else {
          blocks.push(currentBlock.join(' '));
        }
      }
    }
  } else {
    blocks = lines;
  }

  for (let idx = 0; idx < blocks.length; idx++) {
    const rawChunk = blocks[idx];
    const parsedOne = parseSingleLineOrBlock(rawChunk, fallbackYear, refDateStr, fallbackTime, idx);
    if (parsedOne) {
      results.push(parsedOne);
    }
  }

  return results;
}

function parseTabularRows(rows, fallbackYear, refDateStr, fallbackTime) {
  const results = [];
  let colMap = null;

  for (let rIdx = 0; rIdx < rows.length; rIdx++) {
    const cols = rows[rIdx].map((c) => String(c || '').trim());
    if (cols.length < 2) continue;
    const joined = cols.join(' ');

    // 헤더 행 감지
    if (/거래일자|거래일시|입금금액|출금금액|거래후잔액|거래기록사항|기재내용/.test(joined) && !/\d{4,}/.test(joined)) {
      colMap = {
        date: -1,
        time: -1,
        deposit: -1,
        withdraw: -1,
        balance: -1,
        sender: -1,
        type: -1
      };
      cols.forEach((colName, cIdx) => {
        const cn = colName.replace(/\s+/g, '');
        if (/거래일시|거래일자|일자|날짜/.test(cn) && colMap.date === -1) colMap.date = cIdx;
        if (/거래시간|시간/.test(cn)) colMap.time = cIdx;
        if (/입금금액|입금액|맡기신금액/.test(cn)) colMap.deposit = cIdx;
        if (/출금금액|출금액|찾으신금액|지급금액/.test(cn)) colMap.withdraw = cIdx;
        if (/잔액|거래후잔액/.test(cn)) colMap.balance = cIdx;
        if (/기록사항|기재내용|보낸분|입금자|적요|성명|내용/.test(cn) && !/거래내용/.test(cn)) colMap.sender = cIdx;
        if (/거래내용|구분|입출금/.test(cn)) colMap.type = cIdx;
      });
      continue;
    }

    // 헤더 매핑이 있는 경우 정확히 해당 열에서 추출
    if (colMap && colMap.deposit !== -1) {
      const depVal = parseMoneyInt(cols[colMap.deposit]);
      const witVal = colMap.withdraw !== -1 ? parseMoneyInt(cols[colMap.withdraw]) : 0;
      if (depVal <= 0 || witVal > 0) continue;

      const rawDate = colMap.date !== -1 ? cols[colMap.date] : joined;
      const dStr = normalizeDateString(rawDate, fallbackYear) || refDateStr;
      const tStr =
        (colMap.time !== -1 ? normalizeTimeString(cols[colMap.time]) : null) ||
        normalizeTimeString(rawDate) ||
        normalizeTimeString(joined) ||
        fallbackTime;

      let sender = colMap.sender !== -1 ? cols[colMap.sender] : '';
      if (!sender) {
        sender = extractSenderFromCols(cols, [colMap.date, colMap.time, colMap.deposit, colMap.withdraw, colMap.balance]);
      }
      sender = cleanSenderName(sender) || '입금자';
      results.push(buildDepositRecord(dStr, tStr, sender, depVal, results.length));
      continue;
    }

    // 헤더 없이 표 행만 드래그 복사한 경우 (예: 날짜 | 출금(0) | 입금(55,000) | 잔액(4,500,000) | 입금자명 | 지점명)
    const rowRecord = parseHeaderlessTableRow(cols, fallbackYear, refDateStr, fallbackTime, results.length);
    if (rowRecord) {
      results.push(rowRecord);
    }
  }

  return results;
}

function parseHeaderlessTableRow(cols, fallbackYear, refDateStr, fallbackTime, seqIdx) {
  const joined = cols.join(' ');
  // 명시적 출금 행 제외
  if (/출금|지급|체크카드|카드승인/.test(joined) && !/입금/.test(joined)) return null;

  let dateStr = null;
  let timeStr = null;
  const usedIndices = new Set();

  cols.forEach((c, idx) => {
    const d = normalizeDateString(c, fallbackYear);
    const t = normalizeTimeString(c);
    if (d && !dateStr) {
      dateStr = d;
      usedIndices.add(idx);
    }
    if (t && !timeStr) {
      timeStr = t;
      usedIndices.add(idx);
    }
  });

  // 순번 열(1, 2, 3...) 제외 및 금액 열 후보 수집
  const moneyCols = [];
  cols.forEach((c, idx) => {
    if (usedIndices.has(idx)) return;
    const trimmed = c.replace(/원/g, '').trim();
    if (/^\d{1,3}(?:,\d{3})+$|^\d+$/.test(trimmed)) {
      const val = parseMoneyInt(trimmed);
      // 첫 번째 열이고 1~99 사이의 작은 숫자면 순번(No.)으로 간주
      if (idx === 0 && val > 0 && val < 100 && cols.length >= 4) {
        usedIndices.add(idx);
        return;
      }
      moneyCols.push({ idx, val });
    }
  });

  let depositAmount = 0;
  if (moneyCols.length >= 3) {
    // [출금, 입금, 잔액] 구조:
    // 입금 행이면 출금=0, 입금>0 / 또는 입금>0, 출금=0
    const m0 = moneyCols[0];
    const m1 = moneyCols[1];
    const m2 = moneyCols[2];
    usedIndices.add(m0.idx);
    usedIndices.add(m1.idx);
    usedIndices.add(m2.idx);

    if (m0.val === 0 && m1.val > 0) {
      depositAmount = m1.val;
    } else if (m0.val > 0 && m1.val === 0) {
      // 첫 열이 출금이고 둘째 열이 입금인데 출금>0 이면 출금 내역일 수 있으나,
      // 만약 행에 '입금'이라는 단어가 있으면 m0.val을 입금으로 인정
      if (/입금/.test(joined)) {
        depositAmount = m0.val;
      } else {
        return null; // 출금 행 제외
      }
    } else if (m0.val > 0) {
      depositAmount = m0.val;
    }
  } else if (moneyCols.length === 2) {
    // [입금, 잔액] 구조 -> 첫 번째가 입금, 두 번째는 잔액(버림)
    usedIndices.add(moneyCols[0].idx);
    usedIndices.add(moneyCols[1].idx);
    if (moneyCols[0].val > 0) {
      depositAmount = moneyCols[0].val;
    } else {
      depositAmount = moneyCols[1].val;
    }
  } else if (moneyCols.length === 1) {
    usedIndices.add(moneyCols[0].idx);
    depositAmount = moneyCols[0].val;
  }

  if (depositAmount <= 0) return null;

  // 남은 열에서 입금자명 추출 (거래구분/지점명 제외)
  const textCandidates = [];
  cols.forEach((c, idx) => {
    if (usedIndices.has(idx)) return;
    const cleaned = cleanSenderName(c);
    if (!cleaned) return;
    if (/^(?:입금|대체입금|타행입금|무통장입금|스마트뱅킹|인터넷뱅킹|자동이체|모바일|정상)$/.test(cleaned)) return;
    if (/(?:지점|영업부|출장소|중앙회|농협은행)$/.test(cleaned) && textCandidates.length > 0) return;
    textCandidates.push(cleaned);
  });

  const sender = textCandidates[0] || '입금자';
  return buildDepositRecord(dateStr || refDateStr, timeStr || fallbackTime, sender, depositAmount, seqIdx);
}

function extractSenderFromCols(cols, excludeIndices) {
  const ex = new Set(excludeIndices.filter((i) => i >= 0));
  for (let i = 0; i < cols.length; i++) {
    if (ex.has(i)) continue;
    const c = cleanSenderName(cols[i]);
    if (c && !/^\d+$/.test(c) && !/^(?:입금|대체입금|타행입금)$/.test(c)) {
      return c;
    }
  }
  return '입금자';
}

function parseSingleLineOrBlock(rawChunk, fallbackYear, refDateStr, fallbackTime, seqIdx) {
  if (!rawChunk) return null;

  // 출금 전용 문자 제외 (단, '입금' 단어가 함께 있으면 허용)
  if (/출금|지급|체크승인|카드승인|자동이체출금/.test(rawChunk) && !/입금/.test(rawChunk)) {
    return null;
  }

  // 잔액 부분 및 계좌번호 제거 (프라이버시 보호)
  let cleaned = rawChunk
    .replace(/잔액\s*[:：]?\s*[\d,]+\s*원?/gi, ' ')
    .replace(/가능잔액\s*[:：]?\s*[\d,]+\s*원?/gi, ' ')
    .replace(/\[Web발신\]/gi, ' ')
    .replace(/\d{3,6}-\*{2,6}-\*{2,6}-\d{1,4}/g, ' ')
    .replace(/\d{3}-\d{2,4}-\d{4,6}-\d{1,3}/g, ' ')
    .replace(/\d{3,6}-\d{2,4}-\*{2,6}/g, ' ');

  // 날짜 및 시간 먼저 추출 후 텍스트에서 제거 (날짜 숫자가 금액으로 오인되는 것 방지)
  const dStr = normalizeDateString(cleaned, fallbackYear) || refDateStr;
  const tStr = normalizeTimeString(cleaned) || fallbackTime;

  let withoutDateTime = cleaned
    .replace(/\d{4}[-./년\s]+\d{1,2}[-./월\s]+\d{1,2}일?/g, ' ')
    .replace(/(?:^|\s)\d{1,2}\/\d{1,2}(?=\s|$)/g, ' ')
    .replace(/\d{1,2}:\d{2}(?::\d{2})?/g, ' ');

  // 금액 추출:
  // 1순위: '입금 35,000원', '35,000원', '35,000', '35000'
  let amount = 0;
  const explicitWonMatch =
    withoutDateTime.match(/입금(?:액|금액)?\s*[:：]?\s*([\d,]{2,})\s*원?/) ||
    withoutDateTime.match(/([\d,]{2,})\s*원/);

  if (explicitWonMatch) {
    amount = parseMoneyInt(explicitWonMatch[1]);
    withoutDateTime = withoutDateTime.replace(explicitWonMatch[0], ' ');
  } else {
    // 콤마가 있는 숫자 또는 3자리 이상 숫자 추출 (예: '홍길동 35,000' 또는 '홍길동 35000')
    const numTokens = withoutDateTime.match(/\b(\d{1,3}(?:,\d{3})+|\d{3,9})\b/g);
    if (numTokens && numTokens.length > 0) {
      // 0이 아닌 첫 번째 유효 금액 선택 (만약 '0 55,000' 형태면 55,000 선택)
      for (const tok of numTokens) {
        const v = parseMoneyInt(tok);
        if (v > 0) {
          amount = v;
          withoutDateTime = withoutDateTime.replace(tok, ' ');
          break;
        }
      }
    }
  }

  if (!amount || amount <= 0) return null;

  const sender = cleanSenderName(withoutDateTime) || '입금자';
  return buildDepositRecord(dStr, tStr, sender, amount, seqIdx);
}

function cleanSenderName(raw) {
  if (!raw) return '';
  return String(raw)
    .replace(/\[?NH농협(?:은행)?\]?|\[?농협(?:은행)?\]?|NH스마트뱅킹|NH올원뱅크|기업뱅킹|올원뱅크/gi, ' ')
    .replace(/입금알림|입금내역|거래내역|입금자명|입금자|보낸분|기재내용|거래기록사항|적요|성명/g, ' ')
    .replace(/대체입금|타행입금|무통장입금|입금|정상|원/g, ' ')
    .replace(/[\d,]+\s*원/g, ' ')
    .replace(/\b\d{1,3}(?:,\d{3})+\b/g, ' ')
    .replace(/[:：[\]()/|-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildDepositRecord(dateStr, timeStr, sender, amount, seqIdx = 0) {
  const cleanSenderKey = (sender || '입금자').replace(/\s+/g, '');
  const deterministicId = `nh_${dateStr.replace(/-/g, '')}_${timeStr.replace(':', '')}_${amount}_${cleanSenderKey}`;
  const ts = new Date(`${dateStr}T${timeStr}:00`).getTime() || Date.now() + seqIdx;

  return {
    id: deterministicId,
    date: dateStr,
    time: timeStr,
    timestamp: ts,
    sender: sender || '입금자',
    amount: amount,
    confirmed: false,
    confirmedAt: null,
    memo: '',
    tags: [],
    updatedAt: Date.now()
  };
}

// --------------------------------------------------------------------------
// 4. 농협 엑셀 파일(.xls / .xlsx / .csv / .txt) 직접 업로드 처리
// --------------------------------------------------------------------------
function handleExcelFileUpload(event) {
  const file = event.target?.files?.[0];
  if (!file) return;

  const reader = new FileReader();
  const fileName = file.name.toLowerCase();

  if (fileName.endsWith('.csv') || fileName.endsWith('.txt')) {
    reader.onload = async (e) => {
      const text = e.target.result;
      await handleExtractedFileText(text, file.name);
      event.target.value = '';
    };
    reader.readAsText(file, 'euc-kr'); // 한글 엑셀 CSV 인코딩 호환
  } else {
    reader.onload = async (e) => {
      try {
        const data = new Uint8Array(e.target.result);
        if (typeof XLSX === 'undefined') {
          alert('엑셀 분석 라이브러리를 불러오는 중입니다. 잠시 후 다시 시도하거나 내용을 복사해 붙여넣어 주세요.');
          return;
        }
        const workbook = XLSX.read(data, { type: 'array' });
        let allRows = [];
        workbook.SheetNames.forEach((sheetName) => {
          const sheet = workbook.Sheets[sheetName];
          const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });
          allRows = allRows.concat(rows);
        });

        const tabText = allRows.map((r) => r.map((c) => String(c || '').replace(/\r?\n/g, ' ').trim()).join('\t')).join('\n');
        await handleExtractedFileText(tabText, file.name);
      } catch (err) {
        console.error('Excel parse error:', err);
        alert('엑셀 파일 분석 중 오류가 발생했습니다. 파일 내용을 드래그 복사하여 붙여넣기 창에 넣어주세요.');
      } finally {
        event.target.value = '';
      }
    };
    reader.readAsArrayBuffer(file);
  }
}

async function handleExtractedFileText(extractedText, fileName) {
  const modalOpen = document.getElementById('pasteModal')?.classList.contains('open');
  if (modalOpen) {
    const textarea = document.getElementById('bulkPasteTextarea');
    if (textarea) {
      textarea.value = extractedText;
      updatePastePreview();
    }
  } else {
    const count = ingestRawText(extractedText, true);
    if (count > 0) {
      showToast('엑셀 입금 내역 등록 완료', `${fileName}에서 입금 내역 ${count}건을 등록했습니다.`);
      await pushToCloud();
    } else {
      openPasteModal();
      const textarea = document.getElementById('bulkPasteTextarea');
      if (textarea) {
        textarea.value = extractedText;
        updatePastePreview();
      }
    }
  }
}

// --------------------------------------------------------------------------
// 5. 실시간 미리보기 & 빠른 등록 바 & 모달 통합 등록
// --------------------------------------------------------------------------
function updatePastePreview() {
  const raw = document.getElementById('bulkPasteTextarea')?.value || '';
  const box = document.getElementById('pastePreviewBox');
  const title = document.getElementById('pastePreviewTitle');
  const listEl = document.getElementById('pastePreviewList');
  if (!box || !title || !listEl) return;

  if (!raw.trim()) {
    box.style.display = 'none';
    state.previewItems = [];
    return;
  }

  const parsed = parseNHDepositText(raw);
  state.previewItems = parsed;
  box.style.display = 'block';

  if (parsed.length === 0) {
    title.style.color = 'var(--danger)';
    title.textContent = '⚠️ 아직 입금 내역(입금자명 + 금액)이 인식되지 않았습니다. (출금 내역은 자동 제외됨)';
    listEl.innerHTML = `<div style="color:var(--text-sub);">팁: '홍길동 35,000' 처럼 입금자명과 금액이 포함되도록 입력해 주세요.</div>`;
    return;
  }

  title.style.color = 'var(--nh-green)';
  title.textContent = `✅ 실시간 인식 성공: 총 ${parsed.length}건의 입금 내역이 추출되었습니다 (잔액·출금 자동 제거됨)`;
  listEl.innerHTML = parsed
    .slice(0, 30)
    .map(
      (item, idx) => `
      <div style="display:flex; justify-content:space-between; padding:4px 8px; background:var(--bg-card); border-radius:6px; border:1px solid var(--border-color);">
        <span><strong>${idx + 1}. [${escapeHtml(item.date)} ${escapeHtml(item.time)}]</strong> ${escapeHtml(item.sender)}</span>
        <strong style="color:var(--nh-green);">+${item.amount.toLocaleString()}원</strong>
      </div>
    `
    )
    .join('');
}

async function submitQuickBar() {
  const senderOrSmsEl = document.getElementById('quickBarSenderOrSms');
  const amountEl = document.getElementById('quickBarAmount');
  const memoEl = document.getElementById('quickBarMemo');

  const rawFirst = (senderOrSmsEl?.value || '').trim();
  const rawAmount = (amountEl?.value || '').trim();
  const rawMemo = (memoEl?.value || '').trim();

  if (!rawFirst && !rawAmount) {
    alert('입금자명(또는 농협 입금 문자)을 입력해 주세요.');
    senderOrSmsEl?.focus();
    return;
  }

  // 금액 칸에도 입력이 있으면 합쳐서 파싱하거나 직접 등록
  const amountVal = parseMoneyInt(rawAmount);
  if (amountVal > 0 && rawFirst) {
    const dStr = getTodayReferenceDateStr();
    const now = new Date();
    const tStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const rec = buildDepositRecord(dStr, tStr, cleanSenderName(rawFirst) || rawFirst, amountVal, Date.now() % 1000);
    rec.id = `${rec.id}_${Date.now() % 10000}`; // 동일인 재입금 허용
    rec.memo = rawMemo;

    state.deletedIds.delete(rec.id);
    state.deposits.unshift(rec);
    state.knownIds.add(rec.id);
    ensureAddedDepositVisible(rec.date);

    saveLocalDeposits();
    renderDayTabs();
    renderDeposits();
    updateKpiSummary();

    if (senderOrSmsEl) senderOrSmsEl.value = '';
    if (amountEl) amountEl.value = '';
    if (memoEl) memoEl.value = '';

    notifyNewDeposit(rec, 1);
    sendTelegramNotification(rec, 1);
    await pushToCloud();
    return;
  }

  // 첫 번째 칸에 문자 전체나 '홍길동 35,000'을 붙여넣은 경우
  const count = ingestRawText(rawFirst, true, rawMemo);
  if (count > 0) {
    if (senderOrSmsEl) senderOrSmsEl.value = '';
    if (amountEl) amountEl.value = '';
    if (memoEl) memoEl.value = '';
    await pushToCloud();
  } else {
    alert('입금액을 함께 입력해 주세요. (예: 입금자명에 "홍길동", 입금액에 "35,000" 입력)');
    amountEl?.focus();
  }
}

function ensureAddedDepositVisible(addedDateStr) {
  // 만약 사용자가 특정 요일 탭을 보고 있었는데 다른 날짜 내역이 추가되면 최근 7일 전체 또는 전체보기로 자동 전환
  if (state.selectedDayOffset !== '7days' && state.selectedDayOffset !== 'all') {
    const currentTabDate = getDateStringDaysAgo(parseInt(state.selectedDayOffset, 10));
    if (currentTabDate !== addedDateStr) {
      state.selectedDayOffset = '7days';
    }
  }
  if (state.selectedDayOffset === '7days' && !isWithinLast7Days(addedDateStr)) {
    state.selectedDayOffset = 'all';
  }
  if (state.statusFilter === 'confirmed') {
    state.statusFilter = 'all';
  }
}

function ingestRawText(rawText, triggerAlert = true, defaultMemo = '') {
  const parsedList = parseNHDepositText(rawText);
  if (parsedList.length === 0) return 0;

  let addedCount = 0;
  let latestNewItem = null;

  for (const item of parsedList) {
    if (defaultMemo && !item.memo) item.memo = defaultMemo;
    state.deletedIds.delete(item.id);

    const existingIdx = state.deposits.findIndex((d) => d.id === item.id);
    if (existingIdx === -1) {
      state.deposits.unshift(item);
      state.knownIds.add(item.id);
      addedCount++;
      if (!latestNewItem) latestNewItem = item;
    } else if ( parsedList.length === 1 ) {
      // 단건 직접/문자 등록 시 같은 분에 동일 금액 재입금인 경우 새 ID 부여해 등록 허용
      item.id = `${item.id}_${Date.now() % 10000}`;
      state.deposits.unshift(item);
      state.knownIds.add(item.id);
      addedCount++;
      latestNewItem = item;
    }
  }

  if (addedCount > 0) {
    sortDepositsDesc();
    if (latestNewItem) ensureAddedDepositVisible(latestNewItem.date);
    saveLocalDeposits();
    renderDayTabs();
    renderDeposits();
    updateKpiSummary();

    if (triggerAlert && latestNewItem) {
      notifyNewDeposit(latestNewItem, addedCount);
      sendTelegramNotification(latestNewItem, addedCount);
    }
  }

  return addedCount;
}

function sortDepositsDesc() {
  state.deposits.sort((a, b) => {
    const dtA = `${a.date || ''} ${a.time || ''}`;
    const dtB = `${b.date || ''} ${b.time || ''}`;
    if (dtA !== dtB) return dtB.localeCompare(dtA);
    return (b.updatedAt || 0) - (a.updatedAt || 0);
  });
}

// --------------------------------------------------------------------------
// 6. 실시간 소리(Web Audio 차임벨) & 한국어 음성(TTS) & 팝업 알림 엔진
// --------------------------------------------------------------------------
function playDepositChimeAndTTS(deposit, count = 1) {
  if (!state.soundEnabled) return;

  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (AudioCtx) {
      const ctx = new AudioCtx();
      const now = ctx.currentTime;
      const notes = [523.25, 659.25, 783.99];
      notes.forEach((freq, idx) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, now + idx * 0.14);

        gain.gain.setValueAtTime(0.001, now + idx * 0.14);
        gain.gain.exponentialRampToValueAtTime(0.28, now + idx * 0.14 + 0.03);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + idx * 0.14 + 0.55);

        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now + idx * 0.14);
        osc.stop(now + idx * 0.14 + 0.6);
      });
    }
  } catch (e) {}

  if ('speechSynthesis' in window) {
    setTimeout(() => {
      try {
        window.speechSynthesis.cancel();
        const amountText = formatKoreanMoneySpeech(deposit.amount);
        const msgText =
          count > 1
            ? `농협 신규 입금 ${count}건이 등록되었습니다. ${deposit.sender}님 ${amountText} 외 ${count - 1}건입니다.`
            : `농협 입금 알림. ${deposit.sender}님, ${amountText} 입금되었습니다.`;
        const utter = new SpeechSynthesisUtterance(msgText);
        utter.lang = 'ko-KR';
        utter.rate = 1.05;
        window.speechSynthesis.speak(utter);
      } catch (e) {}
    }, 550);
  }
}

function formatKoreanMoneySpeech(num) {
  if (num >= 10000) {
    const man = Math.floor(num / 10000);
    const rem = num % 10000;
    return rem > 0 ? `${man}만 ${rem.toLocaleString()}원` : `${man}만원`;
  }
  return `${num.toLocaleString()}원`;
}

function notifyNewDeposit(deposit, count = 1) {
  playDepositChimeAndTTS(deposit, count);

  const title = count > 1 ? `🔔 농협 신규 입금 ${count}건 등록!` : `🔔 농협 신규 입금 도착!`;
  const body = `${deposit.sender} · ${deposit.amount.toLocaleString()}원 (${deposit.time})`;
  showToast(title, body);

  if ('Notification' in window && Notification.permission === 'granted') {
    try {
      new Notification(title, { body, icon: './icon.svg' });
    } catch (e) {}
  }
}

function toggleSoundAlert() {
  state.soundEnabled = !state.soundEnabled;
  localStorage.setItem(STORAGE_KEYS.SOUND_ON, String(state.soundEnabled));
  updateSoundButtonUI();

  if (state.soundEnabled) {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {});
    }
    showToast('소리·음성 알림 켜짐', '새로운 농협 입금이 들어오면 알림음과 음성 안내가 울립니다.');
  } else {
    showToast('소리·음성 알림 꺼짐', '화면에는 실시간으로 표시되며 소리만 무음 처리됩니다.');
  }
}

function updateSoundButtonUI() {
  const btn = document.getElementById('btnSoundToggle');
  if (!btn) return;
  if (state.soundEnabled) {
    btn.classList.add('active-toggle');
    btn.textContent = '🔔 소리·음성 ON';
  } else {
    btn.classList.remove('active-toggle');
    btn.textContent = '🔕 소리 OFF';
  }
}

function showToast(title, desc) {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  const el = document.createElement('div');
  el.className = 'toast-item';
  el.innerHTML = `
    <div class="toast-title">${escapeHtml(title)}</div>
    <div class="toast-desc">${escapeHtml(desc)}</div>
  `;
  container.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity 0.3s';
    setTimeout(() => el.remove(), 300);
  }, 4500);
}

// --------------------------------------------------------------------------
// 7. 최근 7일(일주일) 날짜 필터 및 테이블 렌더링
// --------------------------------------------------------------------------
function renderDayTabs() {
  const container = document.getElementById('dayTabsContainer');
  if (!container) return;

  const weekDays = ['일', '월', '화', '수', '목', '금', '토'];
  const refStr = getTodayReferenceDateStr();
  const last7Count = state.deposits.filter((d) => isWithinLast7Days(d.date)).length;

  let html = `
    <button class="day-tab ${state.selectedDayOffset === '7days' ? 'active' : ''}" onclick="selectDayTab('7days')">
      🗓️ 최근 7일(일주일) <span class="tab-count">${last7Count}</span>
    </button>
    <button class="day-tab ${state.selectedDayOffset === 'all' ? 'active' : ''}" onclick="selectDayTab('all')">
      📂 전체 내역 <span class="tab-count">${state.deposits.length}</span>
    </button>
  `;

  for (let i = 0; i < 7; i++) {
    const dateStr = getDateStringDaysAgo(i, refStr);
    const parts = dateStr.split('-').map((n) => parseInt(n, 10));
    const dObj = new Date(parts[0], parts[1] - 1, parts[2]);
    const mm = dateStr.slice(5, 7);
    const dd = dateStr.slice(8, 10);
    const dayName = weekDays[dObj.getDay()];
    const count = state.deposits.filter((item) => item.date === dateStr).length;

    let label = `${mm}/${dd}(${dayName})`;
    if (i === 0) label = `오늘 ${mm}/${dd}(${dayName})`;
    else if (i === 1) label = `어제 ${mm}/${dd}(${dayName})`;

    html += `
      <button class="day-tab ${state.selectedDayOffset === String(i) ? 'active' : ''}" onclick="selectDayTab('${i}')">
        ${label} <span class="tab-count">${count}</span>
      </button>
    `;
  }

  container.innerHTML = html;
}

function selectDayTab(offset) {
  state.selectedDayOffset = offset;
  renderDayTabs();
  renderDeposits();
}

function setStatusFilter(filter) {
  state.statusFilter = filter;
  ['all', 'unconfirmed', 'confirmed'].forEach((k) => {
    const btn = document.getElementById(`statusBtn_${k}`);
    if (btn) btn.classList.toggle('active', k === filter);
  });
  renderDeposits();
}

function clearSearch() {
  const input = document.getElementById('searchInput');
  if (input) input.value = '';
  renderDeposits();
}

function getFilteredDeposits() {
  const query = (document.getElementById('searchInput')?.value || '').trim().toLowerCase();
  const queryNum = query.replace(/,/g, '');
  const refStr = getTodayReferenceDateStr();

  return state.deposits.filter((d) => {
    if (state.selectedDayOffset === '7days') {
      if (!isWithinLast7Days(d.date)) return false;
    } else if (state.selectedDayOffset !== 'all') {
      const targetDate = getDateStringDaysAgo(parseInt(state.selectedDayOffset, 10), refStr);
      if (d.date !== targetDate) return false;
    }

    if (state.statusFilter === 'unconfirmed' && d.confirmed) return false;
    if (state.statusFilter === 'confirmed' && !d.confirmed) return false;

    if (query) {
      const matchSender = (d.sender || '').toLowerCase().includes(query);
      const matchMemo = (d.memo || '').toLowerCase().includes(query);
      const matchTag = (d.tags || []).some((t) => t.toLowerCase().includes(query));
      const matchAmount =
        (queryNum && String(d.amount).includes(queryNum)) || d.amount.toLocaleString().includes(query);
      if (!matchSender && !matchMemo && !matchTag && !matchAmount) return false;
    }

    return true;
  });
}

function renderDeposits() {
  const tbody = document.getElementById('depositTableBody');
  const emptyBox = document.getElementById('emptyStateBox');
  if (!tbody || !emptyBox) return;

  const list = getFilteredDeposits();

  if (list.length === 0) {
    tbody.innerHTML = '';
    emptyBox.style.display = 'block';
    return;
  }

  emptyBox.style.display = 'none';
  const todayStr = getTodayReferenceDateStr();
  const yesterdayStr = getDateStringDaysAgo(1, todayStr);

  tbody.innerHTML = list
    .map((d) => {
      const rowClass = d.confirmed ? 'row-confirmed' : 'row-unconfirmed';
      let dayBadge = (d.date || '').slice(5).replace('-', '/');
      if (d.date === todayStr) dayBadge = '오늘';
      else if (d.date === yesterdayStr) dayBadge = '어제';

      const tagsHtml = QUICK_ITEM_TAGS.map((tag) => {
        const selected = Array.isArray(d.tags) && d.tags.includes(tag);
        return `<span class="tag-chip ${selected ? 'selected' : ''}" onclick="toggleDepositTag('${d.id}', '${tag}')">${tag}</span>`;
      }).join('');

      return `
        <tr class="deposit-row ${rowClass}">
          <td class="time-cell">
            <div><span style="color:var(--nh-navy); font-weight:800;">${dayBadge}</span> ${escapeHtml(d.time)}</div>
            <span class="time-rel">${escapeHtml(d.date)}</span>
          </td>
          <td class="sender-cell">
            <span class="sender-bank-tag">NH입금</span>${escapeHtml(d.sender)}
          </td>
          <td class="amount-cell">
            +${Number(d.amount).toLocaleString()}원
          </td>
          <td>
            <button
              class="btn-check-status ${d.confirmed ? 'confirmed' : 'unconfirmed'}"
              onclick="toggleConfirmStatus('${d.id}')"
            >
              ${d.confirmed ? '✅ 확인완료' : '🚨 미확인 (체크)'}
            </button>
          </td>
          <td>
            <div class="memo-wrap">
              <div class="quick-tags">${tagsHtml}</div>
              <div class="memo-input-row">
                <input
                  type="text"
                  class="memo-input"
                  placeholder="담당자/메모 입력 후 Enter (예: 김대리 확인)"
                  value="${escapeHtml(d.memo || '')}"
                  onkeydown="if(event.key==='Enter'){this.blur();}"
                  onblur="updateDepositMemo('${d.id}', this.value)"
                />
              </div>
            </div>
          </td>
          <td>
            <div class="action-cell">
              <button class="btn-icon-sm" onclick="shareSingleDepositKakao('${d.id}')" title="카톡/메신저 공유용 복사">💬 카톡복사</button>
              <button class="btn-icon-sm" style="color:var(--text-muted);" onclick="deleteDepositItem('${d.id}')" title="삭제">✕</button>
            </div>
          </td>
        </tr>
      `;
    })
    .join('');
}

function updateKpiSummary() {
  const todayStr = getTodayReferenceDateStr();
  const last7List = state.deposits.filter((d) => isWithinLast7Days(d.date));
  const todayList = state.deposits.filter((d) => d.date === todayStr);
  const unconfirmedList = state.deposits.filter((d) => !d.confirmed);

  const elUnconfCount = document.getElementById('kpiUnconfirmedCount');
  const elUnconfSub = document.getElementById('kpiUnconfirmedSub');
  const elTodayCount = document.getElementById('kpiTodayCount');
  const elTodaySub = document.getElementById('kpiTodaySub');
  const elWeekCount = document.getElementById('kpiWeekCount');
  const elWeekSub = document.getElementById('kpiWeekSub');
  const banner = document.getElementById('liveUnconfirmedBanner');
  const bannerText = document.getElementById('liveBannerText');
  const btnToggleTotal = document.getElementById('btnToggleTotal');

  if (elUnconfCount) elUnconfCount.textContent = `${unconfirmedList.length}건`;
  if (elUnconfSub) {
    elUnconfSub.textContent =
      unconfirmedList.length > 0
        ? `최근: ${unconfirmedList[0].sender} (${unconfirmedList[0].amount.toLocaleString()}원)`
        : '모든 입금이 확인 완료되었습니다';
  }

  const todaySum = todayList.reduce((acc, cur) => acc + (cur.amount || 0), 0);
  const weekSum = last7List.reduce((acc, cur) => acc + (cur.amount || 0), 0);

  if (btnToggleTotal) {
    btnToggleTotal.textContent = state.showTotalAmount ? '금액합계 숨김' : '금액합계 보기';
  }

  if (elTodayCount) {
    elTodayCount.textContent = state.showTotalAmount
      ? `${todayList.length}건 (${todaySum.toLocaleString()}원)`
      : `${todayList.length}건`;
  }
  if (elTodaySub) {
    elTodaySub.textContent = `기준일(${todayStr.slice(5)}) 확인 ${todayList.filter((d) => d.confirmed).length}건 / 미확인 ${todayList.filter((d) => !d.confirmed).length}건`;
  }

  if (elWeekCount) {
    elWeekCount.textContent = state.showTotalAmount
      ? `${last7List.length}건 (${weekSum.toLocaleString()}원)`
      : `${last7List.length}건`;
  }
  if (elWeekSub) {
    elWeekSub.textContent = `최근 7일(${getDateStringDaysAgo(6, todayStr).slice(5)} ~ ${todayStr.slice(5)}) 공유 내역`;
  }

  if (banner && bannerText) {
    if (unconfirmedList.length > 0) {
      banner.style.display = 'flex';
      bannerText.textContent = `미확인 농협 입금 ${unconfirmedList.length}건이 있습니다! (최근: ${unconfirmedList[0].sender}님 ${unconfirmedList[0].amount.toLocaleString()}원)`;
    } else {
      banner.style.display = 'none';
    }
  }
}

function toggleShowTotalAmount() {
  state.showTotalAmount = !state.showTotalAmount;
  localStorage.setItem(STORAGE_KEYS.SHOW_TOTAL, String(state.showTotalAmount));
  updateKpiSummary();
}

// --------------------------------------------------------------------------
// 8. 직원 입금 확인 체크 / 품목 태그 / 메모 실시간 업데이트
// --------------------------------------------------------------------------
async function toggleConfirmStatus(id) {
  const item = state.deposits.find((d) => d.id === id);
  if (!item) return;
  item.confirmed = !item.confirmed;
  item.confirmedAt = item.confirmed ? new Date().toISOString() : null;
  item.updatedAt = Date.now();

  saveLocalDeposits();
  renderDeposits();
  updateKpiSummary();
  await pushToCloud();
}

async function confirmAllVisible() {
  const visible = getFilteredDeposits().filter((d) => !d.confirmed);
  if (visible.length === 0) return;

  const nowTs = Date.now();
  visible.forEach((d) => {
    d.confirmed = true;
    d.confirmedAt = new Date().toISOString();
    d.updatedAt = nowTs;
  });

  saveLocalDeposits();
  renderDeposits();
  updateKpiSummary();
  showToast('일괄 확인완료', `${visible.length}건의 입금 내역을 확인완료 처리했습니다.`);
  await pushToCloud();
}

async function toggleDepositTag(id, tag) {
  const item = state.deposits.find((d) => d.id === id);
  if (!item) return;
  if (!Array.isArray(item.tags)) item.tags = [];

  if (item.tags.includes(tag)) {
    item.tags = item.tags.filter((t) => t !== tag);
  } else {
    item.tags.push(tag);
  }
  item.updatedAt = Date.now();

  saveLocalDeposits();
  renderDeposits();
  await pushToCloud();
}

async function updateDepositMemo(id, newMemo) {
  const item = state.deposits.find((d) => d.id === id);
  if (!item) return;
  const trimmed = (newMemo || '').trim();
  if ((item.memo || '') === trimmed) return;

  item.memo = trimmed;
  item.updatedAt = Date.now();

  saveLocalDeposits();
  await pushToCloud();
}

async function deleteDepositItem(id) {
  if (!confirm('이 입금 내역을 목록에서 삭제하시겠습니까?')) return;
  state.deletedIds.add(id);
  state.deposits = state.deposits.filter((d) => d.id !== id);
  saveLocalDeposits();
  renderDayTabs();
  renderDeposits();
  updateKpiSummary();
  await pushToCloud();
}

function shareSingleDepositKakao(id) {
  const d = state.deposits.find((x) => x.id === id);
  if (!d) return;
  const tagsStr = d.tags && d.tags.length ? `[${d.tags.join('/')}] ` : '';
  const memoStr = d.memo ? ` (${d.memo})` : '';
  const statusStr = d.confirmed ? '✅확인완료' : '🚨미확인';
  const text = `[NH농협 입금확인] ${d.date.slice(5)} ${d.time} | ${d.sender} | ${d.amount.toLocaleString()}원 | ${statusStr} ${tagsStr}${memoStr}`;

  navigator.clipboard.writeText(text).then(() => {
    showToast('카톡 공유 텍스트 복사됨', text);
  });
}

// --------------------------------------------------------------------------
// 9. GitHub `db-store` 브랜치 & Google Apps Script 실시간 양방향 클라우드 동기화
// --------------------------------------------------------------------------
function updateSyncIndicator(online, message) {
  const dot = document.getElementById('syncDot');
  const txt = document.getElementById('syncStatusText');
  const lastTxt = document.getElementById('lastSyncedTimeText');

  if (dot) dot.classList.toggle('offline', !online);
  if (txt) txt.textContent = message;
  if (lastTxt && online) {
    const now = new Date();
    lastTxt.textContent = `마지막 동기화: ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
  }
}

async function syncFromCloud(isInitial = false) {
  // 로컬에서 방금 데이터를 수정/등록한 직후(4초 이내)에는 덮어쓰기 방지를 위해 폴링 스킵
  if (state.isSyncing || (Date.now() - state.lastLocalWriteTs < 4000 && !isInitial)) return;
  const { ghOwner, ghRepo, ghToken, gasWebhook } = state.settings;

  if (!ghToken && !gasWebhook) {
    updateSyncIndicator(false, '로컬 저장 모드 (실시간 작동 중)');
    state.initialLoadDone = true;
    return;
  }

  state.isSyncing = true;
  try {
    let remoteDeposits = null;
    let remoteDeletedIds = [];

    if (ghToken && ghOwner && ghRepo) {
      const apiUrl = `https://api.github.com/repos/${ghOwner}/${ghRepo}/contents/deposits.json?ref=db-store`;
      const res = await fetch(apiUrl, {
        cache: 'no-store',
        headers: {
          Authorization: `Bearer ${ghToken}`,
          Accept: 'application/vnd.github.v3+json',
          'If-None-Match': ''
        }
      });

      // 서버 Date 헤더로 실제 한국 시간(KST) 자동 보정 (PC 시계 오차 해결)
      const serverDateHdr = res.headers.get('date');
      if (serverDateHdr) {
        const srvMs = Date.parse(serverDateHdr);
        if (!isNaN(srvMs)) {
          const kstDate = new Date(srvMs + 9 * 3600 * 1000);
          state.realKstDateStr = kstDate.toISOString().slice(0, 10);
        }
      }

      if (res.ok) {
        const data = await res.json();
        state.lastSha = data.sha;
        const decoded = decodeURIComponent(escape(atob(data.content.replace(/\n/g, ''))));
        const parsed = JSON.parse(decoded);
        if (Array.isArray(parsed.deposits)) {
          remoteDeposits = parsed.deposits;
        }
        if (Array.isArray(parsed.deletedIds)) {
          remoteDeletedIds = parsed.deletedIds;
        }
      }
    }

    if (!remoteDeposits && gasWebhook) {
      const res = await fetch(`${gasWebhook}?action=list&t=${Date.now()}`, { cache: 'no-store' });
      if (res.ok) {
        const parsed = await res.json();
        if (Array.isArray(parsed.deposits)) {
          remoteDeposits = parsed.deposits;
        }
      }
    }

    if (Array.isArray(remoteDeposits)) {
      mergeRemoteDeposits(remoteDeposits, remoteDeletedIds, !isInitial && state.initialLoadDone);
      updateSyncIndicator(true, '🟢 실시간 동기화 중');
    }
  } catch (e) {
    updateSyncIndicator(false, '로컬+클라우드 자동 재연결 대기');
  } finally {
    state.isSyncing = false;
    state.initialLoadDone = true;
  }
}

function mergeRemoteDeposits(remoteList, remoteDeletedIds = [], shouldAlertNew = false) {
  remoteDeletedIds.forEach((id) => state.deletedIds.add(id));

  const map = new Map();
  state.deposits.forEach((d) => {
    if (!state.deletedIds.has(d.id)) {
      map.set(d.id, d);
    }
  });

  let newIncomingItems = [];
  let changed = false;

  for (const r of remoteList) {
    if (!r || !r.id || state.deletedIds.has(r.id)) continue;
    const local = map.get(r.id);
    if (!local) {
      map.set(r.id, r);
      changed = true;
      if (!state.knownIds.has(r.id)) {
        state.knownIds.add(r.id);
        newIncomingItems.push(r);
      }
    } else if ((r.updatedAt || 0) > (local.updatedAt || 0)) {
      map.set(r.id, r);
      changed = true;
    }
  }

  const nextList = Array.from(map.values());
  if (changed || nextList.length !== state.deposits.length) {
    state.deposits = nextList;
    sortDepositsDesc();
    localStorage.setItem(STORAGE_KEYS.DEPOSITS, JSON.stringify(state.deposits));
    localStorage.setItem(STORAGE_KEYS.DELETED_IDS, JSON.stringify(Array.from(state.deletedIds)));
    renderDayTabs();
    renderDeposits();
    updateKpiSummary();
  }

  if (shouldAlertNew && newIncomingItems.length > 0) {
    notifyNewDeposit(newIncomingItems[0], newIncomingItems.length);
  }
}

async function pushToCloud() {
  const { ghOwner, ghRepo, ghToken, gasWebhook } = state.settings;
  if (!ghToken && !gasWebhook) return;

  state.lastLocalWriteTs = Date.now();

  if (ghToken && ghOwner && ghRepo) {
    try {
      const apiUrl = `https://api.github.com/repos/${ghOwner}/${ghRepo}/contents/deposits.json`;
      const getRes = await fetch(`${apiUrl}?ref=db-store`, {
        cache: 'no-store',
        headers: {
          Authorization: `Bearer ${ghToken}`,
          Accept: 'application/vnd.github.v3+json',
          'If-None-Match': ''
        }
      });

      let remoteSha = state.lastSha;
      if (getRes.ok) {
        const getJson = await getRes.json();
        remoteSha = getJson.sha;
        try {
          const remoteDecoded = JSON.parse(decodeURIComponent(escape(atob(getJson.content.replace(/\n/g, '')))));
          if (Array.isArray(remoteDecoded.deposits)) {
            mergeRemoteDeposits(remoteDecoded.deposits, remoteDecoded.deletedIds || [], false);
          }
        } catch (_) {}
      }

      const payloadObj = {
        updatedAt: new Date().toISOString(),
        deposits: state.deposits,
        deletedIds: Array.from(state.deletedIds).slice(-300)
      };

      const contentBase64 = btoa(unescape(encodeURIComponent(JSON.stringify(payloadObj, null, 2))));
      const body = {
        message: `Update NH deposits (${state.deposits.length} items)`,
        content: contentBase64,
        branch: 'db-store'
      };
      if (remoteSha) body.sha = remoteSha;

      const putRes = await fetch(apiUrl, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${ghToken}`,
          Accept: 'application/vnd.github.v3+json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      });

      if (putRes.ok) {
        const putData = await putRes.json();
        state.lastSha = putData.content?.sha || remoteSha;
        updateSyncIndicator(true, '🟢 실시간 동기화 완료');
      }
    } catch (e) {
      console.error('GitHub push error:', e);
    }
  }

  if (gasWebhook) {
    try {
      await fetch(gasWebhook, {
        method: 'POST',
        mode: 'no-cors',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'syncAll', deposits: state.deposits })
      });
    } catch (e) {}
  }
}

async function syncNowManual() {
  showToast('동기화 실행', '최신 농협 입금 내역을 불러오고 있습니다...');
  state.lastLocalWriteTs = 0;
  await syncFromCloud(false);
}

// --------------------------------------------------------------------------
// 10. 모달 조작 & 일괄 붙여넣기 + 1건 입력 통합 처리
// --------------------------------------------------------------------------
function openPasteModal() {
  document.getElementById('pasteModal')?.classList.add('open');
  updatePastePreview();
  setTimeout(() => document.getElementById('bulkPasteTextarea')?.focus(), 100);
}

function closePasteModal() {
  document.getElementById('pasteModal')?.classList.remove('open');
}

async function processBulkPaste() {
  const textarea = document.getElementById('bulkPasteTextarea');
  const raw = (textarea?.value || '').trim();

  const manualSender = (document.getElementById('manualSender')?.value || '').trim();
  const manualAmount = parseMoneyInt(document.getElementById('manualAmount')?.value || '');

  // 만약 붙여넣기 창은 비어있고 하단 1건 직접 입력란에 값을 적은 뒤 [등록하기]를 누른 경우 자동 연결!
  if (!raw && (manualSender || manualAmount > 0)) {
    await addManualDeposit();
    return;
  }

  if (!raw) {
    alert('붙여넣을 농협 입금 문자/표 내용을 입력하시거나, 엑셀 파일을 선택해 주세요.');
    return;
  }

  let totalAdded = ingestRawText(raw, true);

  // 하단 1건 직접 입력란에도 동시에 적혀 있으면 함께 등록
  if (manualSender && manualAmount > 0) {
    await addManualDeposit(true);
    totalAdded++;
  }

  if (totalAdded === 0) {
    alert('인식된 입금 내역이 없습니다.\n예시처럼 "홍길동 35,000" 또는 농협 입금 문자/엑셀 표를 붙여넣어 주세요. (출금 내역은 자동 제외됩니다)');
    return;
  }

  if (textarea) textarea.value = '';
  updatePastePreview();
  closePasteModal();
  showToast('입금 내역 등록 완료', `총 ${totalAdded}건의 입금 내역이 등록되었습니다.`);
  await pushToCloud();
}

async function addManualDeposit(silentClose = false) {
  const senderEl = document.getElementById('manualSender');
  const amountEl = document.getElementById('manualAmount');
  const memoEl = document.getElementById('manualMemo');

  const sender = (senderEl?.value || '').trim();
  const amount = parseMoneyInt(amountEl?.value || '');
  const memo = (memoEl?.value || '').trim();

  if (!sender || !amount || amount <= 0) {
    alert('입금자명과 입금액(예: 35,000)을 입력해 주세요.');
    return;
  }

  const now = new Date();
  const dateStr = getTodayReferenceDateStr();
  const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const rec = buildDepositRecord(dateStr, timeStr, sender, amount, now.getSeconds());
  rec.id = `${rec.id}_${Date.now() % 10000}`;
  rec.memo = memo;

  state.deletedIds.delete(rec.id);
  state.deposits.unshift(rec);
  state.knownIds.add(rec.id);
  ensureAddedDepositVisible(rec.date);

  saveLocalDeposits();
  renderDayTabs();
  renderDeposits();
  updateKpiSummary();

  if (senderEl) senderEl.value = '';
  if (amountEl) amountEl.value = '';
  if (memoEl) memoEl.value = '';

  if (!silentClose) {
    closePasteModal();
    notifyNewDeposit(rec, 1);
    sendTelegramNotification(rec, 1);
    await pushToCloud();
  }
}

async function triggerSampleDeposit() {
  const sampleSenders = ['김민수(명함)', '(주)대박푸드', '이서연스티커', '박지훈전단지', '최유진(리플렛)'];
  const sampleAmounts = [35000, 55000, 110000, 9500, 88000];
  const idx = Math.floor(Math.random() * sampleSenders.length);
  const dateStr = getTodayReferenceDateStr();
  const mm = dateStr.slice(5, 7);
  const dd = dateStr.slice(8, 10);
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const min = String(now.getMinutes()).padStart(2, '0');

  const sampleSms = `[Web발신] NH농협 입금 ${sampleAmounts[idx].toLocaleString()}원 ${mm}/${dd} ${hh}:${min} ${sampleSenders[idx]} 잔액 15,420,000원`;
  ingestRawText(sampleSms, true);
  await pushToCloud();
}

// --------------------------------------------------------------------------
// 11. 설정 모달 & 직원 공유용 원클릭 링크(#ghSync) & Google Apps Script
// --------------------------------------------------------------------------
function openSettingsModal() {
  document.getElementById('ghOwnerInput').value = state.settings.ghOwner || 'joonoodesign';
  document.getElementById('ghRepoInput').value = state.settings.ghRepo || 'nh-deposit-monitor';
  document.getElementById('ghTokenInput').value = state.settings.ghToken || '';
  document.getElementById('gasWebhookInput').value = state.settings.gasWebhook || '';
  document.getElementById('tgBotTokenInput').value = state.settings.tgBotToken || '';
  document.getElementById('tgChatIdInput').value = state.settings.tgChatId || '';

  document.getElementById('settingsModal')?.classList.add('open');
}

function closeSettingsModal() {
  document.getElementById('settingsModal')?.classList.remove('open');
}

async function saveCloudSettings() {
  state.settings.ghOwner = (document.getElementById('ghOwnerInput')?.value || 'joonoodesign').trim();
  state.settings.ghRepo = (document.getElementById('ghRepoInput')?.value || 'nh-deposit-monitor').trim();
  state.settings.ghToken = (document.getElementById('ghTokenInput')?.value || '').trim();
  state.settings.gasWebhook = (document.getElementById('gasWebhookInput')?.value || '').trim();
  state.settings.tgBotToken = (document.getElementById('tgBotTokenInput')?.value || '').trim();
  state.settings.tgChatId = (document.getElementById('tgChatIdInput')?.value || '').trim();

  localStorage.setItem(STORAGE_KEYS.SETTINGS, JSON.stringify(state.settings));
  closeSettingsModal();
  showToast('설정 저장 완료', '실시간 클라우드 동기화를 즉시 실행합니다.');
  await pushToCloud();
  await syncFromCloud(false);
}

function copyStaffShareLink() {
  if (!state.settings.ghToken && !state.settings.gasWebhook) {
    alert('먼저 원클릭 연결 링크로 접속하시거나 [⚙️ 연동·알림 설정]에서 토큰을 저장해 주세요.');
    openSettingsModal();
    return;
  }

  const syncPayload = {
    o: state.settings.ghOwner || 'joonoodesign',
    r: state.settings.ghRepo || 'nh-deposit-monitor',
    t: state.settings.ghToken || '',
    g: state.settings.gasWebhook || '',
    tb: state.settings.tgBotToken || '',
    tc: state.settings.tgChatId || ''
  };

  const encoded = btoa(JSON.stringify(syncPayload));
  const baseUrl = `${window.location.origin}${window.location.pathname}`;
  const shareUrl = `${baseUrl}#ghSync=${encodeURIComponent(encoded)}`;

  navigator.clipboard.writeText(shareUrl).then(() => {
    showToast('🔗 직원 공유링크 복사 완료!', '카카오톡 단톡방에 붙여넣기 하시면 직원들이 클릭 한 번으로 실시간 연결됩니다.');
  });
}

function copyShortcutUrlGuide() {
  const baseUrl = `${window.location.origin}${window.location.pathname}`;
  const guideUrl = `${baseUrl}?sms=`;
  navigator.clipboard.writeText(guideUrl).then(() => {
    showToast('휴대폰 호출 URL 복사됨', `${guideUrl}[단축어 메시지 본문] 형태로 설정하세요.`);
  });
}

function copyGasScriptCode() {
  const ghOwner = state.settings.ghOwner || 'joonoodesign';
  const ghRepo = state.settings.ghRepo || 'nh-deposit-monitor';
  const ghToken = state.settings.ghToken || '여기에_GITHUB_TOKEN_입력';

  const gasCode = `// =========================================================================
// 주누디자인 NH농협 입금 문자(SMS) 24시간 자동 수신 & 구글 드라이브/GitHub 실시간 연동기
// =========================================================================
const GH_OWNER = '${ghOwner}';
const GH_REPO = '${ghRepo}';
const GH_TOKEN = '${ghToken}';

function doGet(e) {
  const sms = (e && e.parameter && e.parameter.sms) ? e.parameter.sms : '';
  if (sms) return handleIncomingSms(sms);
  return ContentService.createTextOutput(JSON.stringify({ status: 'ok' })).setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  let sms = '';
  if (e && e.parameter && e.parameter.sms) sms = e.parameter.sms;
  else if (e && e.postData && e.postData.contents) {
    try {
      const body = JSON.parse(e.postData.contents);
      sms = body.sms || body.message || body.text || e.postData.contents;
    } catch (_) {
      sms = e.postData.contents;
    }
  }
  if (sms) return handleIncomingSms(sms);
  return ContentService.createTextOutput(JSON.stringify({ status: 'empty' })).setMimeType(ContentService.MimeType.JSON);
}

function handleIncomingSms(rawText) {
  if (/출금|지급|체크승인/.test(rawText) && !/입금/.test(rawText)) {
    return ContentService.createTextOutput(JSON.stringify({ status: 'ignored_withdrawal' })).setMimeType(ContentService.MimeType.JSON);
  }
  const cleaned = rawText.replace(/잔액\\s*[:：]?\\s*[\\d,]+\\s*원?/gi, '').replace(/\\[Web발신\\]/gi, '');
  const amtMatch = cleaned.match(/([\\d,]{3,})\\s*원?/);
  if (!amtMatch) {
    return ContentService.createTextOutput(JSON.stringify({ status: 'no_amount' })).setMimeType(ContentService.MimeType.JSON);
  }
  const amount = parseInt(amtMatch[1].replace(/,/g, ''), 10);
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 3600 * 1000);
  const dateStr = kst.toISOString().slice(0, 10);
  const timeStr = kst.toISOString().slice(11, 16);

  const sender = cleaned
    .replace(/\\[?NH농협\\]?|\\[?농협\\]?|입금|[\\d,]+\\s*원|\\d{1,2}\\/\\d{1,2}|\\d{1,2}:\\d{2}/gi, ' ')
    .replace(/\\s+/g, ' ')
    .trim() || '입금자';

  const id = 'nh_' + dateStr.replace(/-/g, '') + '_' + timeStr.replace(':', '') + '_' + amount + '_' + sender.replace(/\\s+/g, '');
  const newRecord = {
    id: id,
    date: dateStr,
    time: timeStr,
    timestamp: Date.now(),
    sender: sender,
    amount: amount,
    confirmed: false,
    memo: '',
    tags: [],
    updatedAt: Date.now()
  };

  const apiUrl = 'https://api.github.com/repos/' + GH_OWNER + '/' + GH_REPO + '/contents/deposits.json';
  const getRes = UrlFetchApp.fetch(apiUrl + '?ref=db-store', {
    headers: { Authorization: 'Bearer ' + GH_TOKEN, Accept: 'application/vnd.github.v3+json' },
    muteHttpExceptions: true
  });

  let deposits = [];
  let deletedIds = [];
  let sha = null;
  if (getRes.getResponseCode() === 200) {
    const data = JSON.parse(getRes.getContentText());
    sha = data.sha;
    const decoded = Utilities.newBlob(Utilities.base64Decode(data.content)).getDataAsString('UTF-8');
    const parsed = JSON.parse(decoded);
    deposits = parsed.deposits || [];
    deletedIds = parsed.deletedIds || [];
  }

  if (!deposits.some(d => d.id === id)) {
    deposits.unshift(newRecord);
    const payload = { updatedAt: new Date().toISOString(), deposits: deposits, deletedIds: deletedIds };
    const putBody = {
      message: 'Auto SMS deposit: ' + sender,
      content: Utilities.base64Encode(Utilities.newBlob(JSON.stringify(payload, null, 2)).getBytes()),
      branch: 'db-store'
    };
    if (sha) putBody.sha = sha;

    UrlFetchApp.fetch(apiUrl, {
      method: 'put',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + GH_TOKEN, Accept: 'application/vnd.github.v3+json' },
      payload: JSON.stringify(putBody),
      muteHttpExceptions: true
    });
  }

  return ContentService.createTextOutput(JSON.stringify({ status: 'added', record: newRecord })).setMimeType(ContentService.MimeType.JSON);
}`;

  navigator.clipboard.writeText(gasCode).then(() => {
    showToast('Google Apps Script 코드 복사 완료!', 'script.google.com 에 붙여넣고 웹 앱으로 배포하시면 24시간 문자 자동수신이 작동합니다.');
  });
}

async function sendTelegramNotification(deposit, count = 1) {
  const { tgBotToken, tgChatId } = state.settings;
  if (!tgBotToken || !tgChatId) return;

  const text =
    count > 1
      ? `🏦 [NH농협 신규 입금 ${count}건]\n• 최근: ${deposit.sender} (${deposit.amount.toLocaleString()}원)\n• 시간: ${deposit.date} ${deposit.time}`
      : `🏦 [NH농협 실시간 입금]\n• 입금자: ${deposit.sender}\n• 입금액: ${deposit.amount.toLocaleString()}원\n• 일시: ${deposit.date} ${deposit.time}`;

  try {
    await fetch(`https://api.telegram.org/bot${tgBotToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: tgChatId, text })
    });
  } catch (e) {}
}

async function testTelegramAlert() {
  const token = (document.getElementById('tgBotTokenInput')?.value || '').trim();
  const chatId = (document.getElementById('tgChatIdInput')?.value || '').trim();
  if (!token || !chatId) {
    alert('텔레그램 봇 토큰과 채팅방 ID를 모두 입력해 주세요.');
    return;
  }
  state.settings.tgBotToken = token;
  state.settings.tgChatId = chatId;
  await sendTelegramNotification(
    { sender: '테스트입금(주누디자인)', amount: 50000, date: getTodayReferenceDateStr(), time: '12:00' },
    1
  );
  showToast('텔레그램 테스트 발송', '텔레그램 채팅방을 확인해 주세요.');
}

async function pruneOlderThan7Days() {
  const beforeCount = state.deposits.length;
  const kept = [];
  state.deposits.forEach((d) => {
    if (isWithinLast7Days(d.date)) {
      kept.push(d);
    } else {
      state.deletedIds.add(d.id);
    }
  });
  state.deposits = kept;
  const removed = beforeCount - state.deposits.length;

  saveLocalDeposits();
  renderDayTabs();
  renderDeposits();
  updateKpiSummary();
  showToast('7일 경과 내역 정리 완료', `${removed}건의 오래된 내역이 정리되었습니다.`);
  await pushToCloud();
}

async function resetAllDataConfirm() {
  if (!confirm('정말로 모든 입금 내역을 초기화하시겠습니까?')) return;
  state.deposits.forEach((d) => state.deletedIds.add(d.id));
  state.deposits = [];
  state.knownIds.clear();
  saveLocalDeposits();
  renderDayTabs();
  renderDeposits();
  updateKpiSummary();
  closeSettingsModal();
  await pushToCloud();
}

function exportToCSV() {
  const list = getFilteredDeposits();
  if (list.length === 0) {
    alert('내보낼 입금 내역이 없습니다.');
    return;
  }

  const headers = ['입금일자', '입금시간', '입금자명', '입금금액', '확인상태', '품목태그', '담당자메모'];
  const rows = list.map((d) => [
    d.date,
    d.time,
    `"${(d.sender || '').replace(/"/g, '""')}"`,
    d.amount,
    d.confirmed ? '확인완료' : '미확인',
    `"${(d.tags || []).join('/')}"`,
    `"${(d.memo || '').replace(/"/g, '""')}"`
  ]);

  const csvContent = '\uFEFF' + [headers.join(','), ...rows.map((r) => r.join(','))].join('\r\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `주누디자인_NH농협입금내역_${getTodayReferenceDateStr()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function openTutorialModal() {
  document.getElementById('tutorialModal')?.classList.add('open');
}

function closeTutorialModal() {
  document.getElementById('tutorialModal')?.classList.remove('open');
}

function toggleTutorialStartup(checked) {
  localStorage.setItem(STORAGE_KEYS.HIDE_TUTORIAL, String(checked));
}

function toggleDarkMode() {
  document.body.classList.toggle('dark-mode');
  const isDark = document.body.classList.contains('dark-mode');
  localStorage.setItem(STORAGE_KEYS.DARK_MODE, String(isDark));
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
