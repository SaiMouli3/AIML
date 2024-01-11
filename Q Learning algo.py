import numpy as np

states = [0, 1, 2]
actions = [0, 1]

def get_reward(state, action):
    return -1 if state == 2 else 0

def is_terminal_state(state):
    return state == 2

q_table = np.zeros((len(states), len(actions)))

learning_rate = 0.1
discount_factor = 0.9
exploration_prob = 0.2
num_episodes = 1000

for episode in range(num_episodes):
    current_state = np.random.choice(states)
    episode_reward = 0

    while True:
        if np.random.uniform(0, 1) < exploration_prob:
            action = np.random.choice(actions)
        else:
            action = np.argmax(q_table[current_state])

        next_state = (current_state + action) % len(states)
        reward = get_reward(current_state, action)

        q_table[current_state, action] = (1 - learning_rate) * q_table[current_state, action] + \
                                         learning_rate * (reward + discount_factor * np.max(q_table[next_state]))

        current_state = next_state
        episode_reward += reward

        if is_terminal_state(current_state):
            break

    if (episode + 1) % 10 == 0:
        print(f"Episode {episode + 1}, Cumulative Reward: {episode_reward}")
