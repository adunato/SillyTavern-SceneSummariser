# Add Scene Title and Description

## Status
Draft

## Goals
- Introduce a "Scene Title" (a brief title for the entire summarised scene).
- Introduce a "Scene Description" (a short description of the scene).
- Incorporate the "Scene Title" as part of the current format, i.e., "Scene #1 - <Title>".
- Provide an editable dedicated text box for "Scene Description" within the snapshot accordion.
- Update the prompt injection point to include the scene title, but explicitly exclude the scene short description.

## Proposed Solution
- **Update Prompts:** Expand the current system prompt logic to instruct the LLM to generate a `title` and `description` alongside the standard summary.
- **Update Snapshot UI:** 
  - Modify the HTML generation for the snapshot accordion header to display `Scene #${index} - ${title}`.
  - Inject a new editable `<textarea>` or input element inside the snapshot accordion body for the `description`.
  - Bind the description `<textarea>` to an edit/save event handler to persist changes to the snapshot data.
- **Update Injection Logic:** Modify the code responsible for injecting the snapshot into the prompt so that it uses the `title` and `summary` but safely ignores the `description` field.