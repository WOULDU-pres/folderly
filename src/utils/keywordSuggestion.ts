export const PDF_EXTRACT_KEYWORD_SUGGESTIONS = [
  '부채증명 발급 의뢰서',
  '신용정보조회서',
  '신용도판단정보 및 공공정보 변동분 조회',
  '채권자변동정보 조회서',
  '전국 지방세 체납 및 정리보류 및 미납내역 안내',
  '지방세 세목별 과세증명서',
  '사실증명',
  '소득금액증명',
  '부가가치세 과세표준증명',
  '폐업사실증명',
  '납부내역증명',
  '국민연금보험료 미납증명',
  '국민연금 수급증명(지급내역)',
  '연금산정용 가입내역 확인서(개인)',
  '개인회생 신청용 확인서',
  '건강보험자격득실확인서',
  '가입자 건강장기요양보험료 납부 확인서',
  '국민건강보험 보험료 미납내역서',
  '보험내역 조회결과',
  '예상 해지환급금 증명서',
  '지적전산자료 조회결과',
  '가족관계증명서',
  '혼인관계증명서',
  '주민등록초본',
  '주민등록등본',
  '출입국에 관한 사실증명',
  '자동차등록원부(갑)',
  '이륜자동차대장',
  '자동차보험증권 현대해상화재보험',
  '소유자(실질주주)정보',
  '페이인포',
  '채무조정 안내문',
  '채무조정 합의서',
  '변제계획 이행현황',
  '채무변제계획 이행현황 확인서',
] as const

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[^\p{L}\p{N}]/gu, '')
}

function isSubsequence(query: string, target: string): boolean {
  if (!query) return false
  let pointer = 0

  for (const char of target) {
    if (char === query[pointer]) {
      pointer += 1
      if (pointer === query.length) return true
    }
  }

  return false
}

function buildBigrams(value: string): Set<string> {
  if (value.length <= 1) return new Set([value])
  const grams = new Set<string>()
  for (let index = 0; index < value.length - 1; index += 1) {
    grams.add(value.slice(index, index + 2))
  }
  return grams
}

function diceSimilarity(a: string, b: string): number {
  if (!a || !b) return 0
  if (a === b) return 1

  const aBigrams = buildBigrams(a)
  const bBigrams = buildBigrams(b)

  let intersections = 0
  for (const gram of aBigrams) {
    if (bBigrams.has(gram)) {
      intersections += 1
    }
  }

  return (2 * intersections) / (aBigrams.size + bBigrams.size)
}

function scoreCandidate(query: string, candidate: string): number {
  if (!query || !candidate) return 0

  let score = 0
  if (candidate.startsWith(query)) score += 120
  if (candidate.includes(query)) score += 80
  if (isSubsequence(query, candidate)) score += 45
  score += diceSimilarity(query, candidate) * 100

  return score
}

export function findKeywordSuggestion(input: string, keywords: readonly string[]): string | null {
  const normalizedQuery = normalizeText(input)
  if (normalizedQuery.length < 2) return null

  let bestKeyword: string | null = null
  let bestScore = 0

  for (const keyword of keywords) {
    const normalizedKeyword = normalizeText(keyword)
    if (!normalizedKeyword) continue
    if (normalizedKeyword === normalizedQuery) continue

    const score = scoreCandidate(normalizedQuery, normalizedKeyword)
    if (score > bestScore) {
      bestScore = score
      bestKeyword = keyword
    }
  }

  return bestScore >= 75 ? bestKeyword : null
}
