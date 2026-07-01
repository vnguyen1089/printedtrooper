@workflow @email-alert @aw-content
Feature: Notify AW Content Verbal Order workflow rule
  As a Salesforce administrator
  I want the existing "Notify AW Content Verbal Order" workflow rule updated with OR logic
  So that email alerts fire for verbal orders across all AW Content product editions

  # References
  # - Workflow email alert: https://penton.my.salesforce-setup.com/lightning/setup/WorkflowEmails/page?address=%2F01W2A000000PavR
  # - Flow: https://penton.my.salesforce-setup.com/one/one.app#/alohaRedirect/builder_platform_interaction/flowBuilder.app?flowDefId=300PL000005xyrl&isdtp=p1
  # - Email template: https://penton.lightning.force.com/one/one.app?NonSetupLayoutReload=#/alohaRedirect/00X2A000000kwqy?isdtp=p1
  # - Product edition list: image-20260626-235443.png

  Background:
    Given the workflow rule "Notify AW Content Verbal Order" exists and is active
    And the workflow rule is linked to the "Notify AW Content Verbal Order" email alert
    And the email alert uses the configured AW Content verbal order email template
    And the related Flow definition "300PL000005xyrl" remains unchanged unless explicitly required by this story

  @criteria @or-logic
  Scenario: Workflow rule entry criteria use OR logic for AW Content editions
    Given the workflow rule entry criteria are evaluated when a record is created or edited to meet the rule conditions
    When the rule criteria are updated to use custom filter logic with OR between edition conditions
    Then the filter logic includes OR operators between Edition Name criteria
    And at least one Edition Name criterion uses the "contains" operator with value "AW Content"
    And all product editions listed in image-20260626-235443.png are covered by the updated criteria
    And existing non-edition criteria required for verbal orders remain enforced

  @criteria @scenario-outline
  Scenario Outline: Verbal order with AW Content edition triggers the email alert
    Given a verbal order record exists with Edition Name "<edition_name>"
    And the record satisfies all other existing workflow rule entry criteria
    When the record is saved and meets the workflow rule trigger conditions
    Then the "Notify AW Content Verbal Order" workflow rule evaluates to true
    And the "Notify AW Content Verbal Order" email alert is sent to the configured recipients
  # Edition names below must match image-20260626-235443.png. Replace placeholders if the screenshot lists different values.
    Examples:
      | edition_name                         |
      | AW Content - AW&ST Digital           |
      | AW Content - MRO Network             |
      | AW Content - Defense                 |
      | AW Content - Space                   |
      | AW Content - Commercial Aviation     |
      | AW Content - Business Aviation       |
      | AW Content - ShowNews                |
      | AW Content - Fleet & MRO Forecast    |

  @criteria @negative
  Scenario: Non-AW Content edition does not trigger the email alert
    Given a verbal order record exists with Edition Name "Non AW Content Edition"
    And the record satisfies all other existing workflow rule entry criteria except Edition Name
    When the record is saved
    Then the "Notify AW Content Verbal Order" workflow rule does not fire
    And the "Notify AW Content Verbal Order" email alert is not sent

  @regression @simple-change
  Scenario: Simple workflow change does not alter unrelated automation
    Given the "Notify AW Content Verbal Order" workflow rule is updated only for edition matching logic
    When the change is deployed to the Penton Salesforce org
    Then recipient lists on the email alert remain unchanged unless explicitly requested
    And the linked email template body and subject remain unchanged unless explicitly requested
    And the related Flow "300PL000005xyrl" behavior is unchanged unless explicitly requested
    And no other workflow rules or process builders are modified as part of this change

  @implementation
  Scenario: Salesforce Setup reflects OR logic for Edition Name contains AW Content
    Given a Salesforce administrator opens the "Notify AW Content Verbal Order" workflow rule in Setup
    When the administrator reviews the Rule Criteria section
    Then the criteria show Edition Name conditions combined with OR logic
    And the Edition Name conditions capture every product edition from image-20260626-235443.png
    And saving the rule keeps the workflow rule active
