/**
 * Student Demographics and Accommodation Statistics Engine
 *
 * Inspects real Firestore and local student schema fields:
 * - Gender: `gender` or `sex` ('Boy'/'Girl' or 'Male'/'Female')
 * - Accommodation: `residence` or `accommodation` ('Hosteller'/'Day Scholar')
 *
 * Missing / Placeholder Data Handling:
 * If students are generated placeholders without confirmed demographic fields,
 * the dashboard reports data as incomplete rather than fabricating counts.
 */

export const STAT_LABELS = {
  all: 'All Students',
  boys: 'Total Boys',
  girls: 'Total Girls',
  hostellers: 'Total Hostellers',
  dayscholars: 'Total Day Scholars',
  boys_dayscholar: 'Boys — Day Scholars',
  boys_hosteller: 'Boys — Hostellers',
  girls_dayscholar: 'Girls — Day Scholars',
  girls_hosteller: 'Girls — Hostellers'
};

/**
 * Normalizes gender from real Firestore/roster student records.
 * Returns 'Boy', 'Girl', or null if incomplete/unconfirmed.
 */
export function parseStudentGender(s) {
  if (!s) return null;
  // If student has no real entered gender, return null (incomplete)
  if (!s.gender && !s.sex) {
    return null;
  }
  const val = String(s.gender || s.sex || '').trim().toLowerCase();
  if (val === 'boy' || val === 'male' || val === 'm') return 'Boy';
  if (val === 'girl' || val === 'female' || val === 'f') return 'Girl';
  return null;
}

/**
 * Normalizes accommodation from real Firestore/roster student records.
 * Returns 'Hosteller', 'Day Scholar', or null if incomplete/unconfirmed.
 */
export function parseStudentAccom(s) {
  if (!s) return null;
  // If student is marked as placeholder OR is an unconfirmed 25EV template record, its mock residence is not real data
  const isPlaceholder = s.placeholder === true ||
    (!s.updatedAt && !s._cloud && !s.gender && s.placeholder !== false && typeof s.rollNumber === 'string' && /^25EV\d{3}$/i.test(s.rollNumber));
  if (isPlaceholder) {
    return null;
  }
  const val = String(s.residence || s.accommodation || '').trim().toLowerCase();
  if (val === 'hosteller' || val === 'hostel' || s.isHosteller === true) return 'Hosteller';
  if (val === 'day scholar' || val === 'dayscholar' || val === 'day_scholar' || s.isHosteller === false) return 'Day Scholar';
  return null;
}

/**
 * Dynamically computes all 9 statistics for the Student Statistics Dashboard.
 *
 * @param {Array<Object>} students Roster of students from Firestore / attendance service
 * @returns {Object} Comprehensive statistics including counts and data completeness flags
 */
export function getStudentStatistics(students = []) {
  const total = students.length;
  let boys = 0;
  let girls = 0;
  let hostellers = 0;
  let dayScholars = 0;
  let boysDayScholar = 0;
  let boysHosteller = 0;
  let girlsDayScholar = 0;
  let girlsHosteller = 0;

  let genderCount = 0;
  let accomCount = 0;
  let bothCount = 0;

  for (const s of students) {
    const g = parseStudentGender(s);
    const a = parseStudentAccom(s);

    if (g) genderCount++;
    if (a) accomCount++;
    if (g && a) bothCount++;

    if (g === 'Boy') boys++;
    if (g === 'Girl') girls++;

    if (a === 'Hosteller') hostellers++;
    if (a === 'Day Scholar') dayScholars++;

    if (g === 'Boy' && a === 'Day Scholar') boysDayScholar++;
    if (g === 'Boy' && a === 'Hosteller') boysHosteller++;
    if (g === 'Girl' && a === 'Day Scholar') girlsDayScholar++;
    if (g === 'Girl' && a === 'Hosteller') girlsHosteller++;
  }

  const missingGender = total - genderCount;
  const missingAccom = total - accomCount;
  const missingBoth = total - bothCount;

  return {
    total,
    genderCount,
    accomCount,
    bothCount,
    boys: { count: boys, validCount: genderCount, missing: missingGender, hasData: genderCount > 0 },
    girls: { count: girls, validCount: genderCount, missing: missingGender, hasData: genderCount > 0 },
    hostellers: { count: hostellers, validCount: accomCount, missing: missingAccom, hasData: accomCount > 0 },
    dayScholars: { count: dayScholars, validCount: accomCount, missing: missingAccom, hasData: accomCount > 0 },
    boysDayScholar: { count: boysDayScholar, validCount: bothCount, missing: missingBoth, hasData: bothCount > 0 },
    boysHosteller: { count: boysHosteller, validCount: bothCount, missing: missingBoth, hasData: bothCount > 0 },
    girlsDayScholar: { count: girlsDayScholar, validCount: bothCount, missing: missingBoth, hasData: bothCount > 0 },
    girlsHosteller: { count: girlsHosteller, validCount: bothCount, missing: missingBoth, hasData: bothCount > 0 }
  };
}
