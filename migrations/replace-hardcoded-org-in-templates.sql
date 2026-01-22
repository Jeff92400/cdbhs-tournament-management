-- Migration: Replace hardcoded organization references with variables in email templates
-- Date: 2026-01-22
-- Purpose: Make stored templates use dynamic organization variables
--
-- INSTRUCTIONS:
-- 1. First run the SELECT queries to see what will be changed
-- 2. Review the results to ensure replacements are correct
-- 3. Run the UPDATE statements
-- 4. Verify with the final SELECT

-- ============================================================
-- STEP 1: PREVIEW - See which templates will be affected
-- ============================================================

-- Check email_templates table
SELECT
    template_key,
    subject_template,
    LEFT(body_template, 200) as body_preview,
    CASE
        WHEN body_template LIKE '%cdbhs92@gmail.com%' THEN 'Has cdbhs92@gmail.com'
        ELSE ''
    END as has_email,
    CASE
        WHEN body_template LIKE '%CDBHS%' OR body_template LIKE '%Comité Départemental%' OR body_template LIKE '%Comite Departemental%' THEN 'Has org name'
        ELSE ''
    END as has_org_name
FROM email_templates
WHERE body_template LIKE '%CDBHS%'
   OR body_template LIKE '%cdbhs92%'
   OR body_template LIKE '%Comité Départemental%'
   OR body_template LIKE '%Comite Departemental%';

-- ============================================================
-- STEP 2: BACKUP - Create backup of current templates (optional)
-- ============================================================

-- Uncomment to create backup table
-- CREATE TABLE email_templates_backup_20260122 AS SELECT * FROM email_templates;

-- ============================================================
-- STEP 3: UPDATE - Replace hardcoded values with variables
-- ============================================================

-- Replace email address
UPDATE email_templates
SET body_template = REPLACE(body_template, 'cdbhs92@gmail.com', '{organization_email}')
WHERE body_template LIKE '%cdbhs92@gmail.com%';

-- Replace "Le CDBHS" (with article)
UPDATE email_templates
SET body_template = REPLACE(body_template, 'Le CDBHS', 'Le {organization_short_name}')
WHERE body_template LIKE '%Le CDBHS%';

-- Replace "au CDBHS" (with preposition)
UPDATE email_templates
SET body_template = REPLACE(body_template, 'au CDBHS', 'au {organization_short_name}')
WHERE body_template LIKE '%au CDBHS%';

-- Replace "du CDBHS" (with preposition)
UPDATE email_templates
SET body_template = REPLACE(body_template, 'du CDBHS', 'du {organization_short_name}')
WHERE body_template LIKE '%du CDBHS%';

-- Replace standalone "CDBHS" in subject templates
UPDATE email_templates
SET subject_template = REPLACE(subject_template, 'CDBHS', '{organization_short_name}')
WHERE subject_template LIKE '%CDBHS%';

-- Replace full organization name (accented version)
UPDATE email_templates
SET body_template = REPLACE(body_template, 'Comité Départemental de Billard des Hauts-de-Seine', '{organization_name}')
WHERE body_template LIKE '%Comité Départemental de Billard des Hauts-de-Seine%';

-- Replace full organization name (non-accented version)
UPDATE email_templates
SET body_template = REPLACE(body_template, 'Comite Departemental Billard Hauts-de-Seine', '{organization_name}')
WHERE body_template LIKE '%Comite Departemental Billard Hauts-de-Seine%';

-- Replace "Comite Departemental de Billard des Hauts-de-Seine" variant
UPDATE email_templates
SET body_template = REPLACE(body_template, 'Comite Departemental de Billard des Hauts-de-Seine', '{organization_name}')
WHERE body_template LIKE '%Comite Departemental de Billard des Hauts-de-Seine%';

-- ============================================================
-- STEP 4: VERIFY - Check results after update
-- ============================================================

-- Verify no hardcoded values remain
SELECT
    template_key,
    subject_template,
    body_template
FROM email_templates
WHERE body_template LIKE '%CDBHS%'
   OR body_template LIKE '%cdbhs92%'
   OR body_template LIKE '%Comité Départemental de Billard des Hauts-de-Seine%'
   OR body_template LIKE '%Comite Departemental%';

-- This should return 0 rows if all replacements were successful

-- ============================================================
-- STEP 5: Show updated templates
-- ============================================================

SELECT template_key, subject_template, body_template
FROM email_templates
ORDER BY template_key;
