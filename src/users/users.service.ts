import { Injectable, NotFoundException, BadRequestException, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from './entities/user.entity';
import { CreateUserDto } from './dto/create-user.dto';
import { UserRole } from './enums/user-role.enum';
import * as bcrypt from 'bcrypt';
import { NotificationsService } from '../notifications/notifications.service';

@Injectable()
export class UsersService {
    constructor(
        @InjectRepository(User)
        private usersRepository: Repository<User>,
        private readonly notificationsService: NotificationsService,
    ) { }

    async create(createUserDto: CreateUserDto): Promise<User> {
        if (createUserDto.password && !createUserDto.password.startsWith('$2b$')) {
            createUserDto.password = await bcrypt.hash(createUserDto.password, 10);
        }
        const user = this.usersRepository.create(createUserDto);
        return this.usersRepository.save(user);
    }

    async formatUserResponse(user: User) {
        const notifications_count = await this.notificationsService.countUnread(user.id);
        let roleTitle: string = user.role;
        // Simple mapping based on known roles
        if (user.role === UserRole.SUPER_ADMIN) roleTitle = 'Super Admin';
        else if (user.role === UserRole.STUDENT) roleTitle = 'Student'; // Capitalized for consistency
        else if (user.role === UserRole.ORGANIZATION_ADMIN) roleTitle = 'Organization Admin';
        else if (user.role === UserRole.FACULTY) roleTitle = 'Faculty';
        else if (user.role === UserRole.UNIVERSITY) roleTitle = 'University';
        else if (user.role === UserRole.NGO) roleTitle = 'NGO';
        else if (user.role === UserRole.CORPORATE) roleTitle = 'Corporate';

        return {
            id: user.id,
            name: user.name,
            email: user.email,
            role: user.role, // Raw role for logic
            roleTitle: roleTitle, // Display role
            type: user.role, // keeping for backward compatibility if frontend uses it
            avatar: user.avatar,
            phone: user.phone,
            city: user.city,
            institution: user.institution,
            department: user.department,
            university: user.university,
            major: user.major,
            bio: user.bio,
            interests: user.interests,
            sdgPreferences: user.sdgPreferences,
            notifications_count,
            organizationId: user.organization?.id,
            orgName: user.orgName,
            orgType: user.orgType,
            contactPerson: user.contactPerson,
            cnic: user.cnic,
            countryCode: user.countryCode,
            joinedDate: user.createdAt,
            faculty_department: user.faculty_department,
            requires_cnic: user.requires_cnic,
            requires_profile_verification: user.requires_profile_verification,
            profile_verified: user.profile_verified,
            identity_verified: user.identity_verified
        };
    }

    async updateGenericProfile(userId: string, dto: any) {
        const user = await this.usersRepository.findOne({ where: { id: userId } });
        if (!user) {
            throw new NotFoundException('User not found');
        }

        // Filter and map fields
        if (dto.name) user.name = dto.name;
        if (dto.institution) user.institution = dto.institution;
        if (dto.university) user.university = dto.university;
        if (dto.city) user.city = dto.city;
        if (dto.phone) user.phone = dto.phone;
        if (dto.avatar) user.avatar = dto.avatar;
        if (dto.bio) user.bio = dto.bio;
        if (dto.department) user.department = dto.department;
        if (dto.faculty_department) user.faculty_department = dto.faculty_department;
        if (dto.requires_cnic !== undefined) user.requires_cnic = dto.requires_cnic;
        if (dto.requires_profile_verification !== undefined) user.requires_profile_verification = dto.requires_profile_verification;
        if (dto.profile_verified !== undefined) user.profile_verified = dto.profile_verified;
        if (dto.identity_verified !== undefined) user.identity_verified = dto.identity_verified;

        // Save
        const updatedUser = await this.usersRepository.save(user);

        const data = await this.formatUserResponse(updatedUser);
        return {
            success: true,
            message: 'Profile updated successfully!',
            data: {
                ...data,
                image: data.avatar,
                avatar_url: data.avatar,
            },
        };
    }

    async findByEmail(email: string): Promise<User | null> {
        return this.usersRepository.findOne({ where: { email }, relations: ['organization'] });
    }

    async findAll(): Promise<User[]> {
        return this.usersRepository.find();
    }

    async findOne(id: string): Promise<User | null> {
        return this.usersRepository.findOne({ where: { id }, relations: ['organization'] });
    }

    async update(id: string, updateUserDto: any): Promise<User> {
        const passwordBeingUpdated = !!(updateUserDto?.password);
        if (updateUserDto.password && !updateUserDto.password.startsWith('$2b$')) {
            updateUserDto.password = await bcrypt.hash(updateUserDto.password, 10);
        }
        await this.usersRepository.update(id, updateUserDto);
        if (passwordBeingUpdated) {
            await this.usersRepository.increment({ id }, 'tokenVersion', 1);
        }
        const user = await this.findOne(id);
        if (!user) {
            throw new NotFoundException('User not found');
        }
        return user;
    }

    async remove(id: string): Promise<void> {
        await this.usersRepository.delete(id);
    }

    async getProfile(id: string) {
        console.log('getProfile called with ID:', id);
        if (!id) {
            throw new BadRequestException('User ID is required');
        }
        const user = await this.findOne(id);
        if (!user) {
            throw new NotFoundException('User not found');
        }
        console.log('Found user role:', user.role);

        return {
            success: true,
            data: await this.formatUserResponse(user),
        };
    }

    async changePassword(userId: string, changePasswordDto: any) {
        const { currentPassword, newPassword } = changePasswordDto;
        const user = await this.usersRepository.findOne({ where: { id: userId } });

        if (!user) {
            throw new NotFoundException('User not found');
        }

        // Verify current password (assuming we have one)
        // If user was created without password (e.g. social login), this might need adjustment
        if (user.password) {
            const isMatch = await bcrypt.compare(currentPassword, user.password);
            if (!isMatch) {
                throw new UnauthorizedException('Current password is incorrect');
            }
        }

        const hashedPassword = await bcrypt.hash(newPassword, 10);
        user.password = hashedPassword;
        user.tokenVersion = (user.tokenVersion ?? 0) + 1;
        await this.usersRepository.save(user);

        return { success: true, message: 'Password changed successfully' };
    }
    async findOrganizationPrimaryUser(organizationId: string): Promise<User | null> {
        return this.usersRepository.findOne({
            where: { organization: { id: organizationId } },
            order: { createdAt: 'ASC' }
        });
    }

    async savePasswordResetToken(userId: string, token: string, expiry: Date): Promise<void> {
        await this.usersRepository.update(userId, {
            passwordResetToken: token,
            passwordResetExpiry: expiry
        });
    }

    async findByResetToken(token: string): Promise<User | null> {
        return this.usersRepository.findOne({
            where: { passwordResetToken: token }
        });
    }

    async updatePassword(userId: string, hashedPassword: string): Promise<void> {
        await this.usersRepository.update(userId, {
            password: hashedPassword,
            passwordResetToken: null as any,
            passwordResetExpiry: null as any
        });
        await this.usersRepository.increment({ id: userId }, 'tokenVersion', 1);
    }
}
