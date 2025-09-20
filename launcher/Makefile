# Makefile for Web Media Player Launcher

# Compiler and flags
CC = g++
CXXFLAGS = -std=c++17 -Wall -Wextra -municode
LDFLAGS = -mwindows -lcomctl32 -lgdi32 -lws2_32 -lshlwapi

# Target executable
TARGET = launcher.exe

# Source files
SRCS = main.cpp

# Object files
OBJS = $(SRCS:.cpp=.o)

.PHONY: all clean

all: $(TARGET)

$(TARGET): $(OBJS)
	$(CC) $(OBJS) -o $(TARGET) $(LDFLAGS)

%.o: %.cpp
	$(CC) $(CXXFLAGS) -c $< -o $@

clean:
	rm -f $(OBJS) $(TARGET)