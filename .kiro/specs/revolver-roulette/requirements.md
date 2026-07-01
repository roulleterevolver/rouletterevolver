# Requirements Document

## Introduction

Revolver Roulette is a web-based, turn-based dueling game inspired by Buckshot Roulette, substituting a six-chamber revolver for the shotgun. A loaded cylinder holds a known mix of live rounds and blanks (counts visible, order hidden). On each turn a participant chooses to fire at themselves or at the opponent, with self-shots on a blank preserving the turn. Players reduce the opponent's hit points to zero to win, aided by a set of tactical items and a revolver-specific "spin the cylinder" action.

This specification is scoped to the **first milestone: a single-player prototype**. The goal of this milestone is to prove that the core gameplay loop is fun. In this prototype, a human player duels a basic AI opponent using play-money only.

### Out of Scope (Future Milestones)

The following are explicitly out of scope for this specification and will be addressed in future specs:

- **Multiplayer**: 1v1 networked play between two human players.
- **Real wagering and crypto**: Solana integration, a pump.fun token, and any real-money or token-based wagers. This milestone uses no wagering of any kind.
- **3D rendering**: This milestone is 2D only.
- **Accounts, matchmaking, leaderboards, and persistence** beyond what is needed to play a single local prototype session.

This out-of-scope context is recorded so design decisions in this milestone do not preclude the larger vision, but no requirement in this document depends on these future features.

## Glossary

- **Game**: The single-player Revolver Roulette application as a whole, including rendering, audio, rules engine, and AI.
- **Rules_Engine**: The component that enforces game rules, manages state transitions, and validates actions.
- **Cylinder**: The revolver's six-chamber magazine holding an ordered sequence of rounds.
- **Chamber**: A single position in the Cylinder that holds at most one round.
- **Round**: A cartridge loaded into a Chamber, classified as either Live or Blank.
- **Live Round**: A Round that deals damage when fired at any participant.
- **Blank Round**: A Round that deals no damage when fired.
- **Current Chamber**: The Chamber whose Round will be fired by the next shot action.
- **Participant**: Either the Player or the AI_Opponent.
- **Player**: The human-controlled participant.
- **AI_Opponent**: The computer-controlled participant.
- **HP**: Hit Points, the integer health value of a Participant; a Participant is defeated at zero HP.
- **Turn**: The period during which a single Participant may take actions.
- **Active_Participant**: The Participant whose Turn is currently in progress.
- **Shot Action**: The act of firing the revolver at a chosen target (self or opponent).
- **Spin Action**: The act of re-randomizing the order of the Rounds remaining in the Cylinder.
- **Item**: A consumable tactical object a Participant may use during a Turn.
- **Item_Inventory**: The set of Items currently held by a Participant.
- **Round_Set**: One loaded Cylinder played from full until emptied; a Match may span multiple Round_Sets.
- **Match**: A complete contest between the Player and AI_Opponent that ends when one Participant reaches zero HP.
- **Damage_Multiplier**: A factor applied to the damage of the next Live Round fired by a Participant.
- **Audio_System**: The component responsible for playing sound effects and ambient audio.
- **Renderer**: The component responsible for drawing the 2D game scene and visual effects.

## Requirements

### Requirement 1: Cylinder Loading and Composition

**User Story:** As a player, I want the revolver loaded with a known mix of live rounds and blanks in a hidden order, so that I can reason about risk without certainty.

#### Acceptance Criteria

1. WHEN a Round_Set begins, THE Rules_Engine SHALL load the Cylinder with a total number of Rounds selected from the inclusive range of 2 to 6, composed of at least 1 Live Round and at least 1 Blank Round, placing exactly one Round per Chamber.
2. WHEN the Cylinder is loaded, THE Rules_Engine SHALL order the Rounds across the Chambers such that every possible ordering is equally likely.
3. IF a requested Cylinder composition cannot satisfy the constraints of at least 1 Live Round and at least 1 Blank Round within the 2 to 6 Round range, THEN THE Rules_Engine SHALL reject the composition without creating partial state and reselect a valid composition.
4. WHEN the Cylinder is loaded, THE Rules_Engine SHALL display the count of Live Rounds and the count of Blank Rounds to both Participants.
5. WHILE a Round_Set is in progress, THE Rules_Engine SHALL keep the count of remaining Live Rounds and remaining Blank Rounds visible to both Participants.
6. WHILE a Round_Set is in progress, THE Rules_Engine SHALL keep the position of each specific Round in the Cylinder hidden from both Participants except where revealed by an Item.
7. WHEN all Chambers have been fired or emptied, THE Rules_Engine SHALL reload the Cylinder as a new Round_Set using the criteria in acceptance criteria 1 through 5.

### Requirement 2: Hit Points and Win Condition

**User Story:** As a player, I want each participant to start with a set amount of health and win by depleting the opponent, so that the duel has a clear objective.

#### Acceptance Criteria

1. WHEN a Match begins, THE Rules_Engine SHALL set the HP of the Player and the AI_Opponent to the same configured starting value, expressed as an integer in the inclusive range of 2 to 6.
2. WHEN a Live Round is fired at a Participant, THE Rules_Engine SHALL reduce that Participant's HP by the base damage of 1 multiplied by the firing Participant's current Damage_Multiplier.
3. WHEN a Blank Round is fired at a Participant, THE Rules_Engine SHALL leave that Participant's HP unchanged.
4. IF a Participant's HP would be reduced below zero, THEN THE Rules_Engine SHALL set that Participant's HP to zero.
5. WHEN a Participant's HP reaches zero, THE Rules_Engine SHALL end the Match and declare the other Participant the winner.
6. WHILE a Match is in progress, THE Renderer SHALL display the current HP of both Participants and update the displayed value within 200 milliseconds of a change.

### Requirement 3: Turn Structure and Shot Resolution

**User Story:** As a player, I want to choose on my turn whether to shoot myself or the opponent with the documented turn-passing rules, so that the core risk-reward decision drives the game.

#### Acceptance Criteria

1. WHILE it is the Player's Turn, THE Rules_Engine SHALL allow the Player to take a Shot Action targeting exactly one of the Player or the AI_Opponent.
2. WHEN a Shot Action targets a Participant, THE Rules_Engine SHALL fire the Round in the Current Chamber at the targeted Participant and resolve that Round's damage effect as defined in Requirement 2.
3. WHEN a Round is fired, THE Rules_Engine SHALL advance the Current Chamber to the next loaded Chamber in Cylinder order.
4. WHEN the Active_Participant fires a Blank Round at themselves, THE Rules_Engine SHALL retain the Turn with the Active_Participant.
5. WHEN the Active_Participant fires a Live Round at themselves, THE Rules_Engine SHALL pass the Turn to the other Participant.
6. WHEN the Active_Participant fires any Round at the opponent, THE Rules_Engine SHALL pass the Turn to the other Participant.
7. IF the Active_Participant attempts a Shot Action when no loaded Chamber remains, THEN THE Rules_Engine SHALL reject the Shot Action and trigger a reload as defined in Requirement 1.
8. IF a Participant attempts a Shot Action while it is not that Participant's Turn, THEN THE Rules_Engine SHALL reject the Shot Action and preserve the current game state without firing a Round.

### Requirement 4: Spin the Cylinder Action

**User Story:** As a player, I want to spin the cylinder to re-randomize the chamber order, so that I can reset the odds when I have lost track of which round is next.

#### Acceptance Criteria

1. WHILE it is the Player's Turn AND at least 2 Rounds remain in the Cylinder, THE Rules_Engine SHALL allow the Player to take a Spin Action.
2. WHEN a Spin Action is taken, THE Rules_Engine SHALL re-order all Rounds remaining in the Cylinder, including the Current Chamber's Round, such that every possible ordering is equally likely while preserving the counts of Live Rounds and Blank Rounds, and set the Current Chamber to the first Round in the new order.
3. WHEN a Spin Action is taken, THE Rules_Engine SHALL invalidate any previously revealed knowledge of the position and classification of all remaining Rounds.
4. WHEN a Spin Action completes, THE Rules_Engine SHALL retain the Turn with the Active_Participant.
5. THE Rules_Engine SHALL allow no more than a configured maximum number of Spin Actions per Turn, where the maximum is an integer in the inclusive range of 1 to 3.
6. IF a Spin Action is attempted when fewer than 2 Rounds remain in the Cylinder or the per-Turn Spin Action limit has been reached, THEN THE Rules_Engine SHALL reject the Spin Action, preserve the current game state, and retain the Turn with the Active_Participant.

### Requirement 5: Items System

**User Story:** As a player, I want to hold and use tactical items, so that I can influence the duel beyond firing the revolver.

#### Acceptance Criteria

1. WHEN a Round_Set begins, THE Rules_Engine SHALL grant each Participant a configured number of Items in the inclusive range of 0 to 4, drawn from the available Item types Magnifying_Glass, Speed_Loader, Medkit, Handcuffs, Inverter, and Hollow_Point, and SHALL cap each Participant's Item_Inventory at a maximum of 4 Items, discarding any Items granted beyond that maximum.
2. WHILE it is the Player's Turn, THE Rules_Engine SHALL allow the Player to use any number of Items from the Player's Item_Inventory, one at a time.
3. WHEN an Item is used, THE Rules_Engine SHALL remove that Item from the using Participant's Item_Inventory.
4. WHEN the Magnifying_Glass Item is used AND the Current Chamber holds a loaded Round, THE Rules_Engine SHALL reveal the classification of the Current Chamber's Round to the using Participant only, and that revealed knowledge SHALL remain valid until the next Spin Action or Shot Action.
5. WHEN the Speed_Loader Item is used, THE Rules_Engine SHALL reload the Cylinder as a new Round_Set as defined in Requirement 1.
6. WHEN the Medkit Item is used, THE Rules_Engine SHALL increase the using Participant's HP by 1 up to the configured starting value, and SHALL leave HP unchanged if the Participant is already at the starting value.
7. WHEN the Handcuffs Item is used, THE Rules_Engine SHALL cause the opponent's next Turn to be skipped.
8. WHEN the Inverter Item is used AND the Current Chamber holds a loaded Round, THE Rules_Engine SHALL change the Current Chamber's Round from Live to Blank or from Blank to Live.
9. WHEN the Hollow_Point Item is used, THE Rules_Engine SHALL set the using Participant's Damage_Multiplier to 2 for the next Live Round that Participant fires.
10. WHEN a Live Round is fired with a Damage_Multiplier greater than 1, THE Rules_Engine SHALL reset the Damage_Multiplier to 1 after resolving the Shot Action.
11. WHILE a Match is in progress, THE Renderer SHALL display the Items held by both Participants.
12. WHEN an Item is used, THE Rules_Engine SHALL retain the Turn with the Active_Participant.
13. IF a Participant attempts to use an Item not present in that Participant's Item_Inventory, THEN THE Rules_Engine SHALL reject the action and preserve the current game state.

### Requirement 6: AI Opponent

**User Story:** As a player, I want a basic AI opponent that makes reasonable decisions, so that the single-player prototype is a real duel.

#### Acceptance Criteria

1. WHILE it is the AI_Opponent's Turn and the AI_Opponent is required to act, THE AI_Opponent SHALL select exactly one action that is a single Shot Action, a single Spin Action, or a single Item use.
2. WHEN the AI_Opponent selects an action, THE AI_Opponent SHALL select only an action permitted by the current game state as defined in Requirements 3, 4, and 5.
3. WHERE the number of remaining Live Rounds derivable from the displayed Round counts and the Rounds already fired is zero, so that all remaining Rounds are Blank Rounds, THE AI_Opponent SHALL take a Shot Action targeting the Player.
4. WHERE the number of remaining Blank Rounds derivable from the displayed Round counts and the Rounds already fired is zero, so that all remaining Rounds are Live Rounds, THE AI_Opponent SHALL take a Shot Action targeting the Player.
5. WHEN the AI_Opponent has confirmed knowledge, derivable from the displayed Round counts or revealed by an Item, that the Current Chamber holds a Blank Round AND the remaining Rounds are not all Blank Rounds, THE AI_Opponent SHALL take a Shot Action targeting the AI_Opponent.
6. WHEN the AI_Opponent takes a Shot Action AND none of the conditions in acceptance criteria 3, 4, and 5 apply, THE AI_Opponent SHALL take a Shot Action targeting the Player.
7. WHEN the AI_Opponent's Turn begins, THE AI_Opponent SHALL produce and apply its chosen action within a maximum of 3 seconds.

### Requirement 7: Match and Round Structure

**User Story:** As a player, I want matches organized into round-sets with automatic reloading, so that play continues smoothly until someone wins.

#### Acceptance Criteria

1. WHEN a Match begins, THE Rules_Engine SHALL initialize the HP of both Participants as defined in Requirement 2 and load the first Round_Set as defined in Requirement 1.
2. WHEN a Match begins, THE Rules_Engine SHALL assign the first Turn to the Player as the Active_Participant.
3. WHILE a Match is in progress, WHEN the Cylinder is emptied, THE Rules_Engine SHALL begin a new Round_Set, retain both Participants' current HP, and declare no winner.
4. WHEN a Match ends, THE Rules_Engine SHALL display the identity of the winning Participant.
5. WHEN a Match ends, THE Rules_Engine SHALL present a control that allows the Player to start a new Match.
6. WHEN the Player chooses to start a new Match, THE Rules_Engine SHALL reset the HP, Item_Inventory, and Damage_Multiplier of both Participants, the Cylinder, and the Turn assignment to their initial values as defined in Requirements 1, 2, and 5.

### Requirement 8: Visual Presentation

**User Story:** As a player, I want a 2D stylized presentation that evokes a grimy retro mood, so that the game feels tense and atmospheric.

#### Acceptance Criteria

1. THE Renderer SHALL render the game scene in 2D using a canvas-based rendering approach at a sustained frame rate of at least 30 frames per second.
2. THE Renderer SHALL apply post-processing-style visual filters including film grain, scanlines, vignette, and chromatic aberration to every rendered frame.
3. WHILE a Match is in progress, THE Renderer SHALL light the scene with a dim amber lamp whose brightness varies only subtly (a slow waver, not a fast strobe), with the brightness variation repeating on an interval between 100 milliseconds and 1000 milliseconds and the variation amplitude small enough that the scene remains clearly readable.
4. WHEN a Participant takes an action, THE Renderer SHALL display a visual response to that action within 200 milliseconds.
5. IF the canvas-based rendering context cannot be initialized, THEN THE Renderer SHALL stop rendering the scene and present a visual indication that rendering is unavailable, while retaining the current Match state.

### Requirement 9: Sound Design

**User Story:** As a player, I want responsive sound design with rising tension, so that each shot and action feels impactful.

#### Acceptance Criteria

1. WHILE a Match is in progress, THE Audio_System SHALL play a continuous ambient drone that loops without audible gaps for the duration of the Match.
2. WHEN a Spin Action is taken, THE Audio_System SHALL begin playing cylinder spin click sounds within 100 milliseconds.
3. WHEN a Shot Action begins resolving, THE Audio_System SHALL begin playing a hammer cock sound within 100 milliseconds.
4. WHEN a Live Round is fired, THE Audio_System SHALL begin playing a gunshot sound within 100 milliseconds at a playback volume greater than that of the dry click sound for a Blank Round.
5. WHEN a Blank Round is fired, THE Audio_System SHALL begin playing a dry click sound within 100 milliseconds.
6. WHEN the Player interacts with a user interface control, THE Audio_System SHALL begin playing a user interface blip sound within 100 milliseconds.
7. WHEN the count of remaining Rounds in the Cylinder decreases, THE Audio_System SHALL increase the playback volume of the tension audio layer by a fixed increment, reaching its maximum volume when 1 Round remains in the Cylinder.
8. IF an audio asset fails to load or play, THEN THE Audio_System SHALL suppress that single sound and continue the Match without interrupting gameplay.
