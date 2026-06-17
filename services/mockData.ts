export interface Recording {
  id: string;
  fileName: string;
  date: string;
  size: string;
}

export interface User {
  id: string;
  name: string;
  email: string;
  password: string;
  affiliation: string;
  nationality: string;
  isAdmin: boolean;
  recordings: Recording[];
}

export const MOCK_USERS: User[] = [
  {
    id: '1',
    name: 'Admin User',
    email: 'admin@viveka.ai',
    password: 'password',
    affiliation: 'Staff',
    nationality: 'India',
    isAdmin: true,
    recordings: [
      { id: 'r1', fileName: 'Admin_Session_Log_001.pdf', date: '2023-10-25', size: '2.4 MB' }
    ]
  },
  {
    id: '2',
    name: 'Dr. Researcher',
    email: 'user@example.com',
    password: 'password',
    affiliation: 'Research',
    nationality: 'United Kingdom',
    isAdmin: false,
    recordings: [
      { id: 'r2', fileName: 'Interview_Participant_A.pdf', date: '2023-11-01', size: '1.8 MB' },
      { id: 'r3', fileName: 'Focus_Group_B_Transcript.pdf', date: '2023-11-05', size: '3.2 MB' }
    ]
  }
];

export const addUser = (user: User) => {
  MOCK_USERS.push(user);
};

export const getUserById = (id: string) => MOCK_USERS.find(u => u.id === id);
export const getAllUsers = () => MOCK_USERS;