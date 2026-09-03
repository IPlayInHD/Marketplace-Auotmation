# Seller interview script

Run once per enrolled seller, before their first workflow, about 25 minutes. The
moderator reads the questions as written. Follow-ups are "Can you say more about that?"
and "What happened next?" only. Do not explain the product before §8. Do not suggest an
answer, a number or a feeling. Record verbatim where possible, in the interview record
(protected store), with the seller ID only.

Recording: notes always; audio only with the consent script §4 permission.

## 0. Opening (read aloud)

> Thanks for doing this. For the next twenty-five minutes I want to understand how you
> sell today. There are no right answers and nothing you say will be judged. I'll take
> notes under a participant number, not your name. If a question doesn't apply, say so.
> You can skip anything or stop at any time.

## 1. Context

| ID | Question |
|---|---|
| IV-01 | How did you get into selling online? |
| IV-02 | Walk me through the last item you sold, from deciding to sell it to handing it over. |
| IV-03 | Which marketplaces did that involve, and why those? |

## 2. Current workflow

| ID | Question |
|---|---|
| IV-04 | When you create a listing, what do you do first, and what do you do last? |
| IV-05 | Where do the words in your listings come from? |
| IV-06 | What do you do with photos? |

## 3. Frequency and time

| ID | Question |
|---|---|
| IV-07 | In a typical week, how many items do you list, and how many do you sell? |
| IV-08 | How long does it take you to get one listing from "I'll sell this" to "it's live"? Think of the last one. |
| IV-09 | How many buyers contacted you about your last five listings, roughly? |

The moderator records the seller's own estimate of listing time as `baseline_prepare_min`
without comment. This is the self-reported baseline for M-05 (OVQ-06).

## 4. Buyer-message burden

| ID | Question |
|---|---|
| IV-10 | What kinds of messages do you get from buyers? |
| IV-11 | Which of those take the most of your time? |
| IV-12 | Tell me about a time buyer messages got in the way of something else. |
| IV-13 | How do you keep track of which conversations need you? |

## 5. Negotiation burden

| ID | Question |
|---|---|
| IV-14 | When a buyer offers less than you asked, what do you do? |
| IV-15 | Tell me about a negotiation that went badly, from your point of view. |
| IV-16 | Do you decide your lowest price before you list, or as you go? |
| IV-17 | Has an offer ever got lost or mixed up between buyers? What happened? |

## 6. Trust concerns

| ID | Question |
|---|---|
| IV-18 | What worries you, if anything, when dealing with a buyer you don't know? |
| IV-19 | What do you think worries buyers when dealing with you? |
| IV-20 | Have you ever sent a buyer somewhere outside the marketplace, or been sent somewhere by a seller? What happened? |

## 7. Existing tools

| ID | Question |
|---|---|
| IV-21 | What tools, apps or templates do you use for selling, if any? |
| IV-22 | Have you ever paid for a tool to help you sell? What was it, and what happened? |
| IV-23 | Have you used any AI assistant for anything to do with selling? Tell me about it. |

## 8. The proposed workflow (moderator describes, then asks)

Read exactly this description. Do not embellish, and do not answer "would you use it"
questions yet.

> Here is what we're testing. You tell us the facts about an item, in your own words, and
> give us photos. A person, standing in for a future assistant, tidies your words into a
> listing without adding anything you didn't say. You approve or change it. You publish it
> yourself on your marketplace, as you do now, and you add a web link and a six-digit
> code. Buyers who follow the link see your item, enter the code, and ask questions; the
> assistant answers only from the facts you gave, and says "I don't have that confirmed"
> when it doesn't know. If a buyer makes an offer, the assistant sends you a short
> summary. Nothing is agreed unless you say yes. You handle the meeting and the payment
> as you do today. The assistant never tells anyone what the item is worth.

| ID | Question |
|---|---|
| IV-24 | What is your first reaction? |
| IV-25 | Which part of that would change your week the most, if any? |
| IV-26 | Which part concerns you, if any? |
| IV-27 | What would you expect to happen when a buyer asks something you didn't tell the assistant? |
| IV-28 | What would you want to see before saying yes to an offer? |

## 9. Approval step (`ASM-05`)

| ID | Question |
|---|---|
| IV-29 | If a buyer offered your asking price while you were asleep, what would you want to happen? |
| IV-30 | How quickly do you usually reply to an offer today? |

Record any unprompted request for automatic acceptance as `asked_auto_accept = yes`.
Do not ask "would you want it to accept for you".

## 10. Reuse intent

| ID | Question |
|---|---|
| IV-31 | After today's two listings, what would make you run a third one through this, and what would stop you? |
| IV-32 | Who else do you know who sells this way? |

## 11. Credible paid intent (`BIZ-092`)

Ask in this order. Stop at the first level the seller declines. Never name a price
before IV-34. Never mention revenue, speed of sale or "worth".

| ID | Question | Level recorded |
|---|---|---|
| IV-33 | Thinking about the tools you already pay for, or don't: what would a tool like this have to do for you to pay for it monthly? | context only |
| IV-34 | If it did that, what monthly amount would feel fair to you? (Record the number. Do not react.) | 2 if an amount is named |
| IV-35 | We have three draft tiers, all hypotheses: [show the FREE / RESELLER / PRO rows of `BUSINESS_MODEL.md` §5 with prices as ranges]. Which, if any, is closest to how you'd want to use it? | tier selected |
| IV-36 | Would you run another real listing through this after the study, at a date we agree now? | 3 if yes with a date |
| IV-37 | We're forming a small named pilot group and scheduling onboarding calls for it. Would you want to be in it? | 4 if yes and scheduled |
| IV-38 | Would you sign a one-page non-binding note saying you intend to join the pilot on [tier] when it exists? Nothing is charged and it can be withdrawn at any time. | 5 if signed |

The moderator says, after IV-38: "To be clear, nothing is paid now or during the study."
Any attempt by the seller to pay is declined and logged.

## 12. Close

> Thank you. Next we'll try the workflow on your first item. Before that, I'll show you
> the consent note again and you can ask anything.

Record `interview_completed = yes`, the time taken, and any deviation from the script.
