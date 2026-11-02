# Product Specification Command

Create a detailed **Product Specification** document in **Bulgarian** (Български език).

**Target:** $ARGUMENTS

## Scope Detection

Determine the scope from the target above:

- **If the target is empty, says "full", "all", "entire product", "целия продукт", or similar** → Generate a **FULL PRODUCT specification** that covers ALL modules and features of the Клиентски портал на Топлофикация Враца. In this mode:
  - Section 3 (Функционални възможности) must be organized BY MODULE, with a subsection for each module (e.g., 3.1 Автентикация, 3.2 Електронен портфейл, 3.3 Партиди и сметки, 3.4 Плащания, 3.5 Администрация, etc.)
  - Section 4 (Потребителски интерфейс) must describe ALL screens across the entire application
  - Section 5 (Интеграции) must cover ALL external and internal integrations
  - The Research Phase must scan ALL controllers, services, entities, and Angular pages — not just a subset
  - The filename should be `customer-portal-full-product-spec.md`
  - This will be a large document — completeness is more important than brevity

- **If the target names a specific feature or module** → Generate a focused specification for that feature/module only, as a self-contained document.

## Instructions

Use the `product-docs-architect` agent to produce the document. The specification must follow the structure and rules below.

## Audience

- **Non-technical stakeholders** (бизнес потребители, мениджъри)
- **IT Directors** (ИТ директори) who need to understand capabilities without reading code
- Avoid source code, raw SQL, or low-level implementation details
- Use clear, accessible language with visual aids (tables, diagrams descriptions, flow descriptions)

## Language

- The entire document MUST be written in **Bulgarian** (Български език)
- Use proper Bulgarian technical terminology, not transliterations
- Use formal register (обръщение с "Вие")
- Section numbering must use standard decimal format (1, 1.1, 1.1.1)

## Output Format

- Produce the document as a **Word-compatible Markdown file** (.md) that can be easily converted to .docx
- Include `<!-- pagebreak -->` between major sections for proper Word pagination
- Use Word-compatible heading hierarchy (# = Heading 1, ## = Heading 2, ### = Heading 3)
- Save the file to: `.claude/docs/specs/` directory with a descriptive filename in English (e.g., `wallet-autopay-product-spec.md`)

## Required Document Structure

The specification MUST contain ALL of the following sections, each with substantive content (not just headers):

### Document Header Block

- Заглавие (Title)
- Версия: 1.0
- Дата: (current date)
- Автор: Екип по продуктова документация
- Статус: Чернова (Draft)
- Език: BG

### Table of Contents

- Auto-generated `[TOC]` marker

### 1. Въведение (Introduction)

- 1.1 Цел на документа (Document Purpose)
- 1.2 Обхват (Scope)
- 1.3 Дефиниции и съкращения (Definitions & Abbreviations)
- 1.4 Референтни документи (Referenced Documents)

### 2. Общ преглед на продукта (Product Overview)

- 2.1 Бизнес контекст (Business Context) — why this feature/module exists
- 2.2 Целеви потребители (Target Users) — who uses it and their roles
- 2.3 Ключови ползи (Key Benefits) — business value delivered
- 2.4 Връзка с други модули (Relationship to Other Modules)

### 3. Функционални възможности (Functional Capabilities)

- For EACH capability:
  - Описание (Description) — what it does in business terms
  - Потребителски сценарий (User Scenario) — step-by-step user journey
  - Бизнес правила (Business Rules) — conditions, validations, constraints
  - Входни данни (Inputs) — what the user provides (described in business terms)
  - Изходни данни / Резултати (Outputs / Results) — what the user receives
  - Изключения и грешки (Exceptions & Errors) — what happens when things go wrong

### 4. Потребителски интерфейс (User Interface)

- 4.1 Описание на екрани (Screen Descriptions) — describe each screen/page
- 4.2 Навигация (Navigation) — how users move through the feature
- 4.3 Ключови елементи на интерфейса (Key UI Elements) — buttons, forms, indicators
- Use tables to describe UI elements (Element | Description | Behavior)

### 5. Интеграции (Integrations)

- 5.1 Външни системи (External Systems) — third-party services involved
- 5.2 Вътрешни модули (Internal Modules) — connections to other parts of the system
- 5.3 Обмен на данни (Data Exchange) — what data flows between systems (described at business level)

### 6. Сигурност и достъп (Security & Access)

- 6.1 Роли и права (Roles & Permissions)
- 6.2 Защита на данните (Data Protection)
- 6.3 Одитна следа (Audit Trail)

### 7. Производителност и надеждност (Performance & Reliability)

- 7.1 Очаквано натоварване (Expected Load)
- 7.2 Времена за отговор (Response Times)
- 7.3 Наличност (Availability)

### 8. Бизнес правила и ограничения (Business Rules & Constraints)

- Summary table of all business rules (ID | Rule | Description | Impact)

### 9. Нефункционални изисквания (Non-Functional Requirements)

- Usability, accessibility, browser support, mobile support, localization

### 10. Отворени въпроси (Open Questions)

- Questions or decisions still pending

### 11. Речник (Glossary)

- Table of terms used in the document (Term | Definition)

### Revision History

- Table: Версия | Дата | Автор | Промени

## Research Phase

Before writing, the agent MUST:

1. Read relevant source code files (controllers, services, entities, Angular components) to understand the actual implementation
2. Check existing documentation in `.claude/docs/`, `.augment/`, and `docs/`
3. Understand the data model, business rules, and user flows from the code
4. Translate technical implementation into business-level descriptions

## Quality Checklist

Before delivering, verify:

- [ ] All 11 sections have substantive content
- [ ] No source code or SQL in the document
- [ ] All text is in Bulgarian with correct terminology
- [ ] Tables are properly formatted
- [ ] User scenarios are clear and step-by-step
- [ ] Business rules are explicitly stated
- [ ] Document is self-contained (readable without other documents)
- [ ] Page break markers are included between major sections

> **Memory**: Agents should consult and update their `.claude/agent-memory/` between sessions.
