# Notify AW Content Verbal Order — Implementation Guide

This document supports the Gherkin acceptance criteria in `features/workflow-rules/notify_aw_content_verbal_order.feature`.

## Scope

Update the existing **Notify AW Content Verbal Order** workflow rule to use **OR** logic for **Edition Name** criteria so all AW Content verbal order products are included.

This is a simple workflow-rule change. Do not modify the related Flow, email template, or recipients unless separately requested.

## Salesforce references

| Artifact | Link |
|---|---|
| Email alert | [Workflow Email Alert `01W2A000000PavR`](https://penton.my.salesforce-setup.com/lightning/setup/WorkflowEmails/page?address=%2F01W2A000000PavR) |
| Flow | [Flow Builder `300PL000005xyrl`](https://penton.my.salesforce-setup.com/one/one.app#/alohaRedirect/builder_platform_interaction/flowBuilder.app?flowDefId=300PL000005xyrl&isdtp=p1) |
| Email template | [Template `00X2A000000kwqy`](https://penton.lightning.force.com/one/one.app?NonSetupLayoutReload=#/alohaRedirect/00X2A000000kwqy?isdtp=p1) |
| Product list | `image-20260626-235443.png` |

## Recommended criteria change

### Option A — Single contains criterion (preferred when all editions share the substring)

If every edition in the screenshot contains the text `AW Content`, use one edition criterion:

| Field | Operator | Value |
|---|---|---|
| Edition Name | contains | AW Content |

Keep any existing non-edition criteria (for example, verbal order type flags) as **AND** conditions.

Example filter logic when one verbal-order criterion exists:

```text
1 AND 2
```

Where:

1. Existing verbal-order criterion (unchanged)
2. Edition Name contains `AW Content`

### Option B — Multiple OR edition criteria

If editions do not share a single substring, add one **contains** or **equals** criterion per product edition from `image-20260626-235443.png` and combine them with **OR**.

Example filter logic:

```text
(1 AND 2) OR (1 AND 3) OR (1 AND 4)
```

Or, if the platform allows grouped logic:

```text
1 AND (2 OR 3 OR 4 OR 5)
```

Where:

1. Existing verbal-order criterion (unchanged)
2–5. Edition Name criteria for each AW Content product edition

## Setup steps

1. In Setup, open **Workflow Rules** and edit **Notify AW Content Verbal Order**.
2. Open **Rule Criteria**.
3. Replace the current edition matching logic with the OR-based logic described above.
4. Confirm every edition listed in `image-20260626-235443.png` is covered.
5. Save and keep the rule **Active**.
6. Verify the linked email alert **Notify AW Content Verbal Order** still points to the same template and recipients.

## Verification checklist

- [ ] Verbal order with each edition from `image-20260626-235443.png` triggers the email alert
- [ ] Verbal order with a non-AW-Content edition does **not** trigger the alert
- [ ] Email recipients unchanged
- [ ] Email template unchanged
- [ ] Related Flow `300PL000005xyrl` unchanged

## Metadata deployment (optional)

If this org is source-controlled, retrieve the parent object workflow file after the Setup change:

```bash
sf project retrieve start -m "Workflow:<ObjectApiName>"
```

For OR logic in metadata, set `booleanFilter` and multiple `criteriaItems` entries. Example pattern:

```xml
<booleanFilter>1 AND (2 OR 3 OR 4)</booleanFilter>
<criteriaItems>
    <field>Object__c.Verbal_Order_Flag__c</field>
    <operation>equals</operation>
    <value>True</value>
</criteriaItems>
<criteriaItems>
    <field>Object__c.Edition_Name__c</field>
    <operation>contains</operation>
    <value>AW Content</value>
</criteriaItems>
```

Replace field API names and criterion values with the values from the live org and product screenshot.
